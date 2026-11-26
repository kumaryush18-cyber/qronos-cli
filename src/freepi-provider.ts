// The free-pi provider: the four free models, served through the token pool.
//
// The one hard rule: free-pi allows about one request at a time per token. So a
// request first asks the pool for a free token, and a busy token is never used
// twice at once. When every token is busy the request WAITS; when a token
// answers 429 it rests and the next request goes to a different one.
//
// Two things are deliberately not done here:
//   - no invented key: the pool's real token is injected per request, so the
//     literal below is never sent to anyone.
//   - no silent model swap: if no token can serve the call, the user is told,
//     rather than being quietly moved to a different model.
import type { AssistantMessage, AssistantMessageEventStream, Model, SimpleStreamOptions, TranscriptContext } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream, lazyStream } from "@earendil-works/pi-ai";
import { streamSimple as openaiStreamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import type { ExtensionAPI, InlineExtension, ProviderConfig } from "@earendil-works/pi-coding-agent";
import {
  FREEPI_BASE_URL,
  FREEPI_MODELS,
  FREEPI_PROVIDER_LABEL,
  FREEPI_PROVIDER_NAME,
  freepiProviderModels,
  type FreepiCatalogModel,
} from "./freepi-models";
import { FreepiTokenPool, type TokenLease } from "./freepi-tokens";
import { readFreepiStore, persistPoolRecords } from "./freepi-store";
import type { ClientIdentity } from "./ad-client-headers";
import { modelRequestHeaders } from "./ad-client-headers";
import { maskFreepiError, wantsConcurrentRetry } from "./freepi-errors";
import { buildRouteEvent, reportRouteEvent, type RouteReportDeps } from "./freepi-route";

/**
 * The pool never takes a key, so this string only satisfies the registration
 * shape. The real token travels in `options.apiKey` for each request.
 */
export const POOL_KEY_PLACEHOLDER = "pool";

/** Where the placeholder key lives, so pi's auth check finds a configured provider. */
export const FREEPI_KEY_ENV = "QRONOS_FREEPI_POOL_KEY";

/** How long one request waits for a free token before it gives up and says so. */
export const FREEPI_WAIT_MS = 90_000;

export const FREEPI_BUSY_MESSAGE =
  "Every free model is busy right now. Wait a few seconds and try again.";

export const FREEPI_NO_TOKEN_MESSAGE =
  "The free models are unavailable right now. Please retry shortly.";

/**
 * The headers a free-pi request carries.
 *
 * `x-session-id` is the important one: one id per token, kept for the life of
 * that token. A fresh id per request looks like a new session every time and
 * breaks free-pi's own accounting.
 */
export function freepiHeaders(lease: TokenLease, identity?: ClientIdentity): Record<string, string> {
  if (!identity) return { "x-session-id": lease.sessionId };
  return modelRequestHeaders(identity, lease.sessionId);
}

/**
 * Pass the inner stream through, and call `onDone` once when it is over —
 * whether it finished with a result, ended with an error event, or the caller
 * stopped reading.
 */
export function trackedStream(
  source: AssistantMessageEventStream,
  onDone: () => void,
): { [Symbol.asyncIterator](): AsyncIterator<unknown>; result(): Promise<unknown> } {
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    onDone();
  };
  return {
    async *[Symbol.asyncIterator]() {
      try {
        for await (const event of source) yield event;
      } finally {
        finish();
      }
    },
    result: () => source.result().finally(finish),
  };
}

/**
 * Mask a provider's insides into one plain sentence.
 *
 * The same rule the Qronos gateway follows: a 429 or a `concurrent_session`
 * from free-pi is not the user's business and leaks our plumbing into the
 * chat. `QRONOS_DEBUG_FREEPI=1` keeps the real text, in brackets, for when we
 * need it.
 */
export function maskEvents(
  source: AssistantMessageEventStream,
  options: { debug?: boolean } = {},
): { [Symbol.asyncIterator](): AsyncIterator<unknown>; result(): Promise<unknown> } {
  const debug = options.debug ?? process.env.QRONOS_DEBUG_FREEPI === "1";
  const mapMessage = (message: unknown): unknown => {
    const record = message as { errorMessage?: string } | undefined;
    if (!record || typeof record.errorMessage !== "string") return message;
    const masked = maskFreepiError(record.errorMessage);
    if (!masked) return message;
    return { ...record, errorMessage: debug ? `${masked} [server: ${record.errorMessage}]` : masked };
  };
  return {
    async *[Symbol.asyncIterator]() {
      for await (const event of source as AsyncIterable<Record<string, unknown>>) {
        const masked = event.type === "error" ? mapMessage(event.error) : undefined;
        yield masked ? { ...event, error: masked } : event;
      }
    },
    result: async () => mapMessage(await source.result()),
  };
}

/** An error shaped like a real answer, so a failure reaches the user the same way. */
export function syntheticError(model: Model<any>, message: string): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage: message,
    timestamp: Date.now(),
  } as unknown as AssistantMessage;
}

export interface PooledStreamOptions {
  pool: FreepiTokenPool;
  /** Seam: the real OpenAI-compatible adapter. */
  openai?: typeof openaiStreamSimple;
  waitMs?: number;
  /** What the client reports to free-pi: version, OS, architecture. */
  identity?: ClientIdentity;
  /** Called after every release, so a cool-down can be written back to disk. */
  onRelease?: () => void;
  /** Seam for tests: where a routing event goes instead of the gateway. */
  routeDeps?: RouteReportDeps;
}

/** The stream function this provider hands to pi. Always defined, never optional. */
export type PooledStreamSimple = (
  model: Model<any>,
  context: TranscriptContext,
  streamOptions?: SimpleStreamOptions,
) => AssistantMessageEventStream;

/**
 * A `streamSimple` that leases a token, sends the request with it, and gives the
 * token back when the answer is finished.
 *
 * The HTTP status is read from `onResponse` so a 429 is recorded honestly:
 * without it, a parked token would look like a healthy one and the next request
 * would hit it again.
 */
export function createPooledStream(options: PooledStreamOptions): PooledStreamSimple {
  const openai = options.openai ?? openaiStreamSimple;
  const waitMs = options.waitMs ?? FREEPI_WAIT_MS;

  /** One attempt: a lease, the request, and a release that happens exactly once. */
  const openOnce = async (model: Model<any>, context: TranscriptContext, streamOptions?: SimpleStreamOptions) => {
    const lease = await options.pool.waitForFree(waitMs);
    if (!lease) throw new Error(FREEPI_BUSY_MESSAGE);
    let status: number | undefined;
    let released = false;
    const startedAt = Date.now();
    const release = () => {
      if (released) return;
      released = true;
      options.pool.release(lease.tokenId, { status });
      try {
        options.onRelease?.();
      } catch {
        // Writing cool-down state must never break the answer.
      }
    };
    // One event per attempt that reached the service, so the admin panel can see
    // which key served which request and what it really cost. Silent by design.
    const report = (message: unknown) => {
      // Reporting is wired by the launcher, never by default: a test or a library
      // user must never post to a real gateway because they made a request.
      if (!options.routeDeps) return;
      reportRouteEvent(
        buildRouteEvent({
          key: lease.tokenId,
          model: model.id,
          status,
          startedAt,
          finishedAt: Date.now(),
          message,
        }),
        options.routeDeps,
      );
    };
    try {
      const inner = openai(model, context, {
        ...streamOptions,
        apiKey: lease.token,
        headers: { ...(streamOptions?.headers ?? {}), ...freepiHeaders(lease, options.identity) },
        onResponse: async (response, respondedModel) => {
          status = response.status;
          await streamOptions?.onResponse?.(response, respondedModel);
        },
      });
      // The RAW stream, so the retry test can read the server's own words; the
      // masking happens where events are handed to the user.
      return { inner, release, report };
    } catch (error) {
      report(undefined);
      release();
      throw error;
    }
  };

  return (model: Model<any>, context: TranscriptContext, streamOptions?: SimpleStreamOptions) => {
    if (options.pool.size === 0) {
      return lazyStream(model, async () => {
        throw new Error(FREEPI_NO_TOKEN_MESSAGE);
      });
    }

    let finalMessage: unknown;
    let notifyDone!: () => void;
    const done = new Promise<void>((resolve) => (notifyDone = resolve));
    let iterated = false;
    const debug = process.env.QRONOS_DEBUG_FREEPI === "1";
    const maskMessage = (message: unknown): unknown => {
      const record = message as { errorMessage?: string } | undefined;
      if (!record || typeof record.errorMessage !== "string") return message;
      const masked = maskFreepiError(record.errorMessage);
      if (!masked) return message;
      return { ...record, errorMessage: debug ? `${masked} [server: ${record.errorMessage}]` : masked };
    };

    // At most two attempts, and only for a real "this token is already in use"
    // answer, and only before a single byte was shown. A silent retry loop would
    // spend the same allowance twice.
    const source = (async function* () {
      try {
        let attempt = 0;
        while (true) {
          let opened: Awaited<ReturnType<typeof openOnce>>;
          try {
            opened = await openOnce(model, context, streamOptions);
          } catch (error) {
            const message = String((error as Error)?.message ?? error);
            if (attempt === 0 && wantsConcurrentRetry(message)) {
              attempt += 1;
              continue;
            }
            finalMessage = syntheticError(model, message);
            yield { type: "error", reason: "error", error: finalMessage };
            return;
          }
          let delivered = 0;
          let retry = false;
          try {
            for await (const event of opened.inner as AsyncIterable<Record<string, any>>) {
              if (
                event?.type === "error" &&
                delivered === 0 &&
                attempt === 0 &&
                wantsConcurrentRetry(event.error?.errorMessage)
              ) {
                retry = true;
                break;
              }
              delivered += 1;
              if (event?.type === "error") {
                // Masked here, at the edge, so the retry test above still sees the
                // server's real words.
                const masked = maskMessage(event.error);
                finalMessage = masked;
                yield { ...event, error: masked };
                continue;
              }
              if (event?.type === "done") finalMessage = event.message;
              yield event;
            }
            if (!retry && finalMessage === undefined) {
              try {
                finalMessage = maskMessage(await opened.inner.result());
              } catch {
                // An adapter with no result is not an error of ours.
              }
            }
          } finally {
            opened.report(finalMessage);
            opened.release();
          }
          if (!retry) return;
          attempt += 1;
        }
      } finally {
        notifyDone();
      }
    })();

    return {
      async *[Symbol.asyncIterator]() {
        iterated = true;
        yield* source;
      },
      async result() {
        if (iterated) await done;
        else for await (const event of source) void event;
        return finalMessage;
      },
    } as unknown as AssistantMessageEventStream;
  };
}

export interface FreepiProviderOptions {
  /**
   * Legacy seam: a saved file. The provider now reads the shared pool only, so
   * this is used just by tests that want a pool without a server.
   */
  path?: string;
  baseUrl?: string;
  now?: () => number;
  waitMs?: number;
  /** Seam: the real OpenAI-compatible adapter. */
  openai?: typeof openaiStreamSimple;
  /** Seam: reading the token file, so a test needs no disk. */
  readTokens?: typeof readFreepiStore;
  /**
   * The process-wide pool. Shared with the ad code on purpose: an ad request
   * and a model request are the same limit, so they must not both take the
   * same token at the same moment.
   */
  getPool?: () => Promise<FreepiTokenPool>;
  /** What the client reports to free-pi: version, OS, architecture. */
  identity?: ClientIdentity;
  /** The real catalogue, when one was fetched. */
  getCatalog?: () => Promise<readonly FreepiCatalogModel[]>;
  /**
   * Where a routing event goes. Only the launcher passes this, so a test or a
   * library user never posts to a real gateway by making a request.
   */
  routeDeps?: RouteReportDeps;
}

/**
 * The extension.
 *
 * It registers a provider only when at least one token is saved: an empty pool
 * would put four models in `/model` that cannot answer a single question, and a
 * model you cannot use is worse than a model you never saw.
 */
export function createFreepiProviderExtension(options: FreepiProviderOptions): InlineExtension {
  return {
    name: "qronos-freepi",
    factory: async (qronos: ExtensionAPI) => {
      let pool: FreepiTokenPool;
      if (options.getPool) {
        pool = await options.getPool();
      } else if (options.path) {
        const readTokens = options.readTokens ?? readFreepiStore;
        pool = new FreepiTokenPool((await readTokens(options.path)).tokens, { now: options.now });
      } else {
        pool = new FreepiTokenPool([], { now: options.now });
      }
      if (pool.size === 0) return;

      // F4: real numbers, when we have them. A failed catalogue is the same as
      // no catalogue: the built-in four answer with their floors.
      let models: readonly FreepiCatalogModel[] = FREEPI_MODELS;
      if (options.getCatalog) {
        try {
          const fetched = await options.getCatalog();
          if (fetched.length > 0) models = fetched;
        } catch {
          // keep the built-in list
        }
      }

      const streamSimple = createPooledStream({
        pool,
        openai: options.openai,
        waitMs: options.waitMs,
        identity: options.identity,
        routeDeps: options.routeDeps,
        onRelease: () => {
          // A saved file is no longer a token source, so there is nothing to
          // write back unless a test handed us a path.
          const path = options.path;
          if (!path) return;
          void persistPoolRecords(path, pool.exportRecords()).catch(() => undefined);
        },
      });

      const debug = process.env.QRONOS_DEBUG_FREEPI === "1";
      if (debug) process.stderr.write(`[freepi] registering ${models.length} models\n`);
      // pi counts a provider as "configured" only when its key resolves. A
      // literal is fine, but the documented env form is what pi's own auth
      // check understands, so we set it here and let the key itself be ignored
      // by our stream (the pool hands out the real token per request).
      process.env[FREEPI_KEY_ENV] = POOL_KEY_PLACEHOLDER;
      qronos.registerProvider(FREEPI_PROVIDER_NAME, {
        name: FREEPI_PROVIDER_LABEL,
        baseUrl: options.baseUrl ?? FREEPI_BASE_URL,
        api: "openai-completions",
        apiKey: `$${FREEPI_KEY_ENV}`,
        models: freepiProviderModels(options.baseUrl ?? FREEPI_BASE_URL, models),
        streamSimple,
      });
      if (debug) {
        process.stderr.write("[freepi] registerProvider returned without throwing\n");
      }
    },
  };
}

/** The model ids this provider adds, for the docs and the tests. */
export const FREEPI_MODEL_IDS = FREEPI_MODELS.map((model) => model.id);

/**
 * The free-pi ids to add to the model picker.
 *
 * None when no token is saved, so the lock does not advertise models that
 * cannot answer. A pool that fails to load is the same as no pool.
 */
export async function freepiScopeIds(getPool: () => Promise<FreepiTokenPool>): Promise<string[]> {
  try {
    const pool = await getPool();
    return pool.size > 0 ? [...FREEPI_MODEL_IDS] : [];
  } catch {
    return [];
  }
}
