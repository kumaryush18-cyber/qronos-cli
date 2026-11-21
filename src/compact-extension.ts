// Compaction, wired into pi.
//
// pi already compacts a long session on its own. This extension replaces that
// one summarization call with a better one, and keeps pi's version as the
// fallback:
//
//   - the input is pruned first (a 30k-token tool dump becomes 700 characters);
//   - exact file paths, commands and error lines are pulled out by code and
//     appended to the summary, so the model cannot paraphrase them away;
//   - secrets are redacted before the checkpoint is stored, because the
//     checkpoint is re-sent on every later prompt;
//   - a summary that is empty, truncated or missing headings is REJECTED, and
//     returning nothing lets pi do its own compaction.
//
// Turning it off (`QRONOS_COMPACT=0`) makes the extension a no-op, and pi
// behaves exactly as before.
import type {
  ExtensionAPI,
  ExtensionContext,
  InlineExtension,
  SessionBeforeCompactResult,
} from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { CLI_VERSION } from "./version";
import { digestMessagesForCompaction } from "./compact-input";
import {
  SUMMARY_SYSTEM_PROMPT,
  approxTokens,
  buildCompactPrompt,
  compactStatusLine,
  readSummary,
  withEvidence,
} from "./compact-summary";

export const COMPACT_STATUS_KEY = "qronos-compact";
export const DEFAULT_COMPACT_TIMEOUT_MS = 120_000;

/** Below this many messages pi's own compaction is already cheap and fine. */
export const MIN_MESSAGES = 6;

export interface CompactConfig {
  enabled: boolean;
  /** Model id for the summary; empty means the session model. */
  model?: string;
  timeoutMs: number;
  /** Keep pi's summary for very small histories. */
  minMessages: number;
}

export function compactConfigFromEnv(env: NodeJS.ProcessEnv = process.env): CompactConfig {
  const off = env.QRONOS_COMPACT === "0" || env.QRONOS_COMPACT === "false";
  const timeout = Number.parseInt(env.QRONOS_COMPACT_TIMEOUT_MS ?? "", 10);
  const minMessages = Number.parseInt(env.QRONOS_COMPACT_MIN_MESSAGES ?? "", 10);
  return {
    enabled: !off,
    model: env.QRONOS_COMPACT_MODEL?.trim() || undefined,
    timeoutMs: Number.isFinite(timeout) && timeout >= 10_000 ? timeout : DEFAULT_COMPACT_TIMEOUT_MS,
    minMessages: Number.isFinite(minMessages) && minMessages >= 1 ? minMessages : MIN_MESSAGES,
  };
}

export type CompactComplete = (
  model: Model<Api>,
  systemPrompt: string,
  prompt: string,
  auth: { apiKey?: string; headers?: Record<string, string> },
) => Promise<string>;

async function defaultComplete(
  model: Model<Api>,
  systemPrompt: string,
  prompt: string,
  auth: { apiKey?: string; headers?: Record<string, string> },
): Promise<string> {
  const response = (await completeSimple(
    model as Model<any>,
    {
      systemPrompt,
      messages: [{ role: "user", timestamp: Date.now(), content: [{ type: "text", text: prompt }] }],
    },
    { apiKey: auth.apiKey, headers: auth.headers },
  )) as { content?: unknown };
  const content = response.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block): block is { type: string; text: string } =>
        !!block && typeof block === "object" && (block as { type?: string }).type === "text",
    )
    .map((block) => block.text)
    .join("\n");
}

async function resolveAuth(
  ctx: ExtensionContext,
  model: Model<Api>,
): Promise<{ apiKey?: string; headers?: Record<string, string> }> {
  try {
    const auth = (await ctx.modelRegistry.getApiKeyAndHeaders(model)) as {
      apiKey?: string;
      headers?: Record<string, string>;
    };
    return {
      apiKey: auth.apiKey,
      headers: { ...(auth.headers ?? {}), "x-client-version": CLI_VERSION, "x-qronos-client": "cli" },
    };
  } catch {
    return {};
  }
}

/** Resolve the summary model: explicit id, else the session model. */
export function resolveCompactModel(
  config: CompactConfig,
  sessionModel: Model<Api> | undefined,
  registry?: ExtensionContext["modelRegistry"],
): Model<Api> | undefined {
  const wanted = config.model?.trim().toLowerCase();
  if (!wanted || !registry) return sessionModel;
  if (sessionModel && registry.find(sessionModel.provider, config.model!)) {
    return registry.find(sessionModel.provider, config.model!) ?? sessionModel;
  }
  const match = registry.getModelsOfType("chat").find((item) => item.id?.toLowerCase() === wanted);
  return match ?? sessionModel;
}

export interface CompactExtensionOptions {
  config?: CompactConfig;
  complete?: CompactComplete;
  /** Injected in tests so a timeout can be simulated without waiting. */
  timeout?: <T>(promise: Promise<T>, ms: number) => Promise<T>;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
    if (typeof timer === "object" && "unref" in timer) (timer as { unref(): void }).unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export interface CompactHandlers {
  /** What the extension returns for one compaction attempt. */
  summarize: (event: unknown, ctx: ExtensionContext) => Promise<SessionBeforeCompactResult>;
}

/**
 * The testable core, separated from the pi event registration.
 *
 * It returns `{}` (meaning "no opinion") whenever it cannot help, which keeps
 * pi's built-in compaction in charge.
 */
export function createCompactHandlers(options: CompactExtensionOptions = {}): CompactHandlers {
  const config = options.config ?? compactConfigFromEnv();
  const complete = options.complete ?? defaultComplete;
  const race = options.timeout ?? withTimeout;

  return {
    async summarize(event: unknown, ctx: ExtensionContext): Promise<SessionBeforeCompactResult> {
      if (!config.enabled) return {};
      const record = (event ?? {}) as {
        preparation?: {
          messagesToSummarize?: unknown[];
          turnPrefixMessages?: unknown[];
          firstKeptEntryId?: string;
          tokensBefore?: number;
          previousSummary?: string;
          isSplitTurn?: boolean;
        };
        customInstructions?: string;
      };
      const preparation = record.preparation;
      if (!preparation) return {};

      const history = Array.isArray(preparation.messagesToSummarize) ? preparation.messagesToSummarize : [];
      const prefix = Array.isArray(preparation.turnPrefixMessages) ? preparation.turnPrefixMessages : [];
      const messages = [...history, ...prefix];
      if (messages.length < config.minMessages) return {};
      // Without a boundary pi could not apply the summary, so do not offer one.
      if (typeof preparation.firstKeptEntryId !== "string" || preparation.firstKeptEntryId === "") return {};

      const model = resolveCompactModel(config, ctx.model, ctx.modelRegistry);
      if (!model) return {};

      const cwd = (ctx as unknown as { cwd?: string }).cwd;
      const digest = digestMessagesForCompaction(messages, cwd);
      const prompt = buildCompactPrompt({
        transcript: digest.transcript,
        evidence: digest.evidence,
        previousSummary: preparation.previousSummary,
        customInstructions: record.customInstructions,
        isSplitTurn: preparation.isSplitTurn,
      });

      try {
        const auth = await resolveAuth(ctx, model);
        const answer = await race(complete(model, SUMMARY_SYSTEM_PROMPT, prompt, auth), config.timeoutMs);
        const read = readSummary(answer);
        if (!read.ok) {
          ctx.ui.setStatus(COMPACT_STATUS_KEY, `kept built-in summary (${read.reason})`);
          return {};
        }
        const summary = withEvidence(read.summary, digest.evidence);
        const tokensAfter = approxTokens(summary);
        ctx.ui.setStatus(COMPACT_STATUS_KEY, compactStatusLine(preparation.tokensBefore ?? 0, summary.length));
        return {
          compaction: {
            summary,
            firstKeptEntryId: preparation.firstKeptEntryId,
            tokensBefore: preparation.tokensBefore ?? 0,
            estimatedTokensAfter: tokensAfter,
            details: {
              source: "qronos-compact",
              evidence: {
                files: digest.evidence.files,
                commands: digest.evidence.commands,
                errors: digest.evidence.errors,
              },
              stats: digest.stats,
            },
          },
        };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        ctx.ui.setStatus(COMPACT_STATUS_KEY, `kept built-in summary (${reason.slice(0, 60)})`);
        return {};
      }
    },
  };
}

export function createCompactExtension(options: CompactExtensionOptions = {}): InlineExtension {
  const handlers = createCompactHandlers(options);
  const extension = (qronos: ExtensionAPI): void => {
    qronos.on("session_before_compact", async (event, ctx) => handlers.summarize(event, ctx));
    qronos.on("session_compact_failed", async (event, ctx) => {
      if (event.aborted) return;
      ctx.ui.setStatus(COMPACT_STATUS_KEY, "compaction failed");
    });
  };
  return { name: "qronos-compact", factory: extension };
}
