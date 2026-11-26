// The free-pi provider: one request per token, the real token per request, and
// a 429 that parks the key instead of retrying it.
import { describe, expect, test } from "bun:test";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import {
  createFreepiProviderExtension,
  createPooledStream,
  freepiScopeIds,
  freepiHeaders,
  trackedStream,
  FREEPI_BUSY_MESSAGE,
  FREEPI_NO_TOKEN_MESSAGE,
  POOL_KEY_PLACEHOLDER,
} from "../src/freepi-provider";
import { FreepiTokenPool, type FreepiTokenRecord } from "../src/freepi-tokens";
import { FREEPI_MODELS, FREEPI_PROVIDER_NAME, isFreepiActiveModel } from "../src/freepi-models";

function records(count: number): FreepiTokenRecord[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `t${index + 1}`,
    token: `fp_secret_token_${index + 1}`,
    sessionId: `session-${index + 1}`,
    coolDownUntil: 0,
    failures: 0,
  }));
}

const MODEL = {
  id: "particle",
  name: "Particle",
  provider: "free",
  api: "openai-completions",
  baseUrl: "https://api.freepi.ai/v1",
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 16_384,
  reasoning: false,
} as any;

const MESSAGE: AssistantMessage = {
  role: "assistant",
  content: [{ type: "text", text: "hello" }],
  api: "openai-completions",
  provider: "free",
  model: "particle",
  usage: {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp: 1,
} as any;

/** A stand-in for the real adapter: reports one response, then answers. */
function fakeAdapter(options: {
  status?: number;
  seen: Array<{ apiKey?: string; headers?: Record<string, string>; sessionId?: string }>;
  /** The final message. A test can hand over one with no usage at all. */
  message?: unknown;
}) {
  return ((_model: unknown, _context: unknown, streamOptions: any) => {
    options.seen.push({
      apiKey: streamOptions?.apiKey,
      headers: streamOptions?.headers,
      sessionId: streamOptions?.headers?.["x-session-id"],
    });
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      void streamOptions?.onResponse?.({ status: options.status ?? 200 }, _model);
      stream.push({ type: "text", text: "hello" } as any);
      stream.end((options.message ?? MESSAGE) as any);
    });
    return stream;
  }) as any;
}

async function drain(stream: any): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("freepiHeaders", () => {
  test("one session id, the token's own", () => {
    expect(freepiHeaders({ tokenId: "t1", token: "secret", sessionId: "session-1" })).toEqual({
      "x-session-id": "session-1",
    });
  });
});

describe("createPooledStream", () => {
  test("the real token is sent per request, never the placeholder", async () => {
    const seen: any[] = [];
    const pool = new FreepiTokenPool(records(1));
    const streamSimple = createPooledStream({ pool, openai: fakeAdapter({ seen }), waitMs: 0 });
    await drain(streamSimple(MODEL, {} as any, {} as any));
    expect(seen[0].apiKey).toBe("fp_secret_token_1");
    expect(seen[0].apiKey).not.toBe(POOL_KEY_PLACEHOLDER);
  });

  test("the session id travels with the request", async () => {
    const seen: any[] = [];
    const pool = new FreepiTokenPool(records(1));
    const streamSimple = createPooledStream({ pool, openai: fakeAdapter({ seen }), waitMs: 0 });
    await drain(streamSimple(MODEL, {} as any, {} as any));
    expect(seen[0].sessionId).toBe("session-1");
  });

  test("the token is free again after the answer", async () => {
    const seen: any[] = [];
    const pool = new FreepiTokenPool(records(1));
    const streamSimple = createPooledStream({ pool, openai: fakeAdapter({ seen }), waitMs: 0 });
    await drain(streamSimple(MODEL, {} as any, {} as any));
    expect(pool.busyCount).toBe(0);
  });

  test("two calls at once use two different tokens", async () => {
    const seen: any[] = [];
    const pool = new FreepiTokenPool(records(2));
    const streamSimple = createPooledStream({ pool, openai: fakeAdapter({ seen }), waitMs: 0 });
    await Promise.all([
      drain(streamSimple(MODEL, {} as any, {} as any)),
      drain(streamSimple(MODEL, {} as any, {} as any)),
    ]);
    expect(new Set(seen.map((entry) => entry.apiKey)).size).toBe(2);
  });

  test("a 429 parks that token, and the next call uses the other one", async () => {
    const seen: any[] = [];
    let now = 0;
    const pool = new FreepiTokenPool(records(2), { now: () => now });
    let status = 429;
    const streamSimple = createPooledStream({
      pool,
      openai: ((model: any, context: any, streamOptions: any) => {
        const adapter = fakeAdapter({ status, seen });
        return adapter(model, context, streamOptions);
      }) as any,
      waitMs: 0,
    });
    await drain(streamSimple(MODEL, {} as any, {} as any));
    status = 200;
    await drain(streamSimple(MODEL, {} as any, {} as any));
    expect(seen[0].apiKey).toBe("fp_secret_token_1");
    expect(seen[1].apiKey).toBe("fp_secret_token_2");
    now += 1;
    expect(pool.snapshot()[0]!.coolDownSeconds).toBeGreaterThan(0);
  });

  test("an empty pool says so, and blames nobody", async () => {
    const pool = new FreepiTokenPool([]);
    const streamSimple = createPooledStream({ pool, openai: fakeAdapter({ seen: [] }), waitMs: 0 });
    const events = await drain(streamSimple(MODEL, {} as any, {} as any));
    const error = events.find((event: any) => event.type === "error") as any;
    expect(error.error.errorMessage).toBe(FREEPI_NO_TOKEN_MESSAGE);
  });

  test("a busy pool waits, then says so instead of failing silently", async () => {
    const pool = new FreepiTokenPool(records(1));
    pool.acquire(); // pretend another request is using the only token
    let now = 0;
    const streamSimple = createPooledStream({ pool, openai: fakeAdapter({ seen: [] }), waitMs: 0 });
    const events = await drain(streamSimple(MODEL, {} as any, {} as any));
    const error = events.find((event: any) => event.type === "error") as any;
    expect(error.error.errorMessage).toBe(FREEPI_BUSY_MESSAGE);
    expect(now).toBe(0);
  });

  test("the adapter throwing a real error still frees the token", async () => {
    const pool = new FreepiTokenPool(records(1));
    const streamSimple = createPooledStream({
      pool,
      openai: (() => {
        throw new Error("boom");
      }) as any,
      waitMs: 0,
    });
    const events = await drain(streamSimple(MODEL, {} as any, {} as any));
    expect((events.find((event: any) => event.type === "error") as any).error.errorMessage).toBe("boom");
    expect(pool.busyCount).toBe(0);
  });

  test("release happens once, even when the caller also asks for the result", async () => {
    const pool = new FreepiTokenPool(records(1));
    let releases = 0;
    const streamSimple = createPooledStream({
      pool,
      openai: fakeAdapter({ seen: [] }),
      waitMs: 0,
      onRelease: () => {
        releases += 1;
      },
    });
    const stream: any = streamSimple(MODEL, {} as any, {} as any);
    await drain(stream);
    await stream.result?.();
    expect(releases).toBe(1);
  });
});

describe("trackedStream", () => {
  test("an unfinished stream still calls the hook when the reader stops", async () => {
    let done = 0;
    const inner = createAssistantMessageEventStream();
    const wrapped: any = trackedStream(inner, () => {
      done += 1;
    });
    const iterator = wrapped[Symbol.asyncIterator]();
    inner.push({ type: "text", text: "a" } as any);
    await iterator.next();
    await iterator.return?.();
    expect(done).toBe(1);
  });
});

describe("createFreepiProviderExtension", () => {
  function host() {
    const registered: Array<{ name: string; config: any }> = [];
    return {
      api: { registerProvider: (name: string, config: any) => registered.push({ name, config }) } as any,
      registered,
    };
  }

  test("no tokens means no provider at all", async () => {
    const { api, registered } = host();
    const extension = createFreepiProviderExtension({
      path: "/nowhere",
      readTokens: async () => ({ version: 1, tokens: [] }),
    });
    await (extension as any).factory(api);
    expect(registered).toEqual([]);
  });

  test("with a token, the four free models are registered", async () => {
    const { api, registered } = host();
    const extension = createFreepiProviderExtension({
      path: "/nowhere",
      readTokens: async () => ({ version: 1, tokens: records(1) }),
    });
    await (extension as any).factory(api);
    expect(registered.length).toBe(1);
    expect(registered[0]!.name).toBe(FREEPI_PROVIDER_NAME);
    const ids = registered[0]!.config.models.map((model: any) => model.id);
    expect(ids).toEqual(FREEPI_MODELS.map((model) => model.id));
  });

  test("every model is free, in words and in numbers", async () => {
    const { api, registered } = host();
    const extension = createFreepiProviderExtension({
      path: "/nowhere",
      readTokens: async () => ({ version: 1, tokens: records(1) }),
    });
    await (extension as any).factory(api);
    for (const model of registered[0]!.config.models) {
      expect(model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
      expect(model.input).toEqual(["text"]);
      expect(model.contextWindow).toBeGreaterThan(0);
    }
  });

  test("the provider carries a stream function, not a static key", async () => {
    const { api, registered } = host();
    const extension = createFreepiProviderExtension({
      path: "/nowhere",
      readTokens: async () => ({ version: 1, tokens: records(1) }),
    });
    await (extension as any).factory(api);
    expect(typeof registered[0]!.config.streamSimple).toBe("function");
    // The env form is what pi's own auth check understands as "configured".
    // The value is still a placeholder: every request takes a real token from
    // the pool, so this key is never sent.
    expect(registered[0]!.config.apiKey).toBe("$QRONOS_FREEPI_POOL_KEY");
    expect(process.env.QRONOS_FREEPI_POOL_KEY).toBe(POOL_KEY_PLACEHOLDER);
  });

  test("the token file is never read when the factory is not called", async () => {
    let reads = 0;
    const extension = createFreepiProviderExtension({
      path: "/nowhere",
      readTokens: async () => {
        reads += 1;
        return { version: 1, tokens: [] };
      },
    });
    expect(reads).toBe(0);
    expect((extension as any).name).toBe("qronos-freepi");
  });
});

describe("isFreepiActiveModel", () => {
  test("the provider name alone is enough", () => {
    expect(isFreepiActiveModel("free", undefined)).toBe(true);
    expect(isFreepiActiveModel("free", "something-new")).toBe(true);
  });

  test("a matching model id is enough, even under another provider", () => {
    expect(isFreepiActiveModel("openrouter", "particle")).toBe(true);
  });

  test("another model on another provider is not ours", () => {
    expect(isFreepiActiveModel("qronos", "claude-haiku-5.5")).toBe(false);
    expect(isFreepiActiveModel(undefined, undefined)).toBe(false);
  });
});

describe("concurrent_session: one retry, then a plain sentence", () => {
  test("a thrown concurrent_session releases the token and tries again with a fresh one", async () => {
    const seen: any[] = [];
    const pool = new FreepiTokenPool(records(2));
    let calls = 0;
    const streamSimple = createPooledStream({
      pool,
      waitMs: 0,
      openai: ((model: any, context: any, streamOptions: any) => {
        calls += 1;
        if (calls === 1) throw new Error("concurrent_session: token already has an active request");
        return fakeAdapter({ seen })(model, context, streamOptions);
      }) as any,
    });
    const events = await drain(streamSimple(MODEL, {} as any, {} as any));
    expect(calls).toBe(2);
    expect(seen).toHaveLength(1);
    expect(seen[0].apiKey).toBe("fp_secret_token_2");
    expect(pool.busyCount).toBe(0);
    expect(events.length).toBeGreaterThan(0);
  });

  test("it is tried once only, never in a loop", async () => {
    let calls = 0;
    const pool = new FreepiTokenPool(records(2));
    const streamSimple = createPooledStream({
      pool,
      waitMs: 0,
      openai: ((() => {
        calls += 1;
        throw new Error("concurrent_session");
      }) as any),
    });
    const events = (await drain(streamSimple(MODEL, {} as any, {} as any))) as any[];
    const errorEvent = events.find((event) => event.type === "error");
    expect(errorEvent?.error?.errorMessage ?? "").toContain("concurrent_session");
    expect(calls).toBe(2);
    expect(pool.busyCount).toBe(0);
  });

  test("an unrelated failure is not retried", async () => {
    let calls = 0;
    const pool = new FreepiTokenPool(records(2));
    const streamSimple = createPooledStream({
      pool,
      waitMs: 0,
      openai: ((() => {
        calls += 1;
        throw new Error("model not found");
      }) as any),
    });
    const events = (await drain(streamSimple(MODEL, {} as any, {} as any))) as any[];
    const errorEvent = events.find((event) => event.type === "error");
    expect(errorEvent?.error?.errorMessage ?? "").toContain("model not found");
    expect(calls).toBe(1);
  });

  test("an error event whose words are a rate limit becomes the plain sentence", async () => {
    const pool = new FreepiTokenPool(records(1));
    const streamSimple = createPooledStream({
      pool,
      waitMs: 0,
      openai: ((() => {
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => {
          stream.push({ type: "error", reason: "error", error: { ...MESSAGE, errorMessage: "429 rate limit exceeded" } } as any);
        });
        return stream;
      }) as any),
    });
    const events = (await drain(streamSimple(MODEL, {} as any, {} as any))) as any[];
    const errorEvent = events.find((event) => event.type === "error");
    expect(errorEvent.error.errorMessage).toBe(
      "The selected model is at high usage right now and is unavailable. Please retry shortly.",
    );
    expect(errorEvent.error.errorMessage).not.toContain("429");
    expect(errorEvent.error.errorMessage).not.toContain("free");
  });
});

describe("one silent routing event per request", () => {
  const routeDeps = (sent: any[]) => ({
    enabled: () => true,
    authToken: async () => "qr_test",
    origin: "https://api.qronos.me",
    fetchImpl: (async (_url: string, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)));
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch,
  });

  test("the real input and output tokens of that request are reported", async () => {
    const seen: any[] = [];
    const sent: any[] = [];
    const pool = new FreepiTokenPool(records(1));
    const streamSimple = createPooledStream({
      pool,
      openai: fakeAdapter({ seen }),
      waitMs: 0,
      routeDeps: routeDeps(sent) as any,
    });
    await drain(streamSimple(MODEL, {} as any, {} as any));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ key: "t1", slot: null, model: "particle", status: 200, inputTokens: 1, outputTokens: 1 });
  });

  test("a refused request is reported with its status and no token counts", async () => {
    const seen: any[] = [];
    const sent: any[] = [];
    const pool = new FreepiTokenPool(records(1));
    const streamSimple = createPooledStream({
      pool,
      openai: fakeAdapter({ seen, status: 429, message: { ...MESSAGE, usage: undefined } }),
      waitMs: 0,
      routeDeps: routeDeps(sent) as any,
    });
    await drain(streamSimple(MODEL, {} as any, {} as any));
    expect(sent[0]).toMatchObject({ status: 429, inputTokens: null, outputTokens: null });
  });

  test("with no reporting wired, a request stays completely local", async () => {
    const seen: any[] = [];
    const pool = new FreepiTokenPool(records(1));
    const streamSimple = createPooledStream({ pool, openai: fakeAdapter({ seen }), waitMs: 0 });
    await drain(streamSimple(MODEL, {} as any, {} as any));
    expect(seen).toHaveLength(1);
  });
});

describe("the catalogue gives the real numbers", () => {
  test("a registered model carries the server's context and output sizes", async () => {
    const registered: any[] = [];
    const extension = createFreepiProviderExtension({
      path: "/nonexistent/freepi.json",
      readTokens: (async () => ({ version: 1 as const, tokens: records(1) })) as any,
      getCatalog: async () => [
        { id: "particle", name: "Particle (free)", contextWindow: 200_000, maxTokens: 32_000 },
      ],
    });
    await (extension as any).factory({
      registerProvider: (name: string, config: any) => registered.push({ name, config }),
    } as any);
    const model = registered[0].config.models.find((m: any) => m.id === "particle");
    expect(model.contextWindow).toBe(200_000);
    expect(model.maxTokens).toBe(32_000);
  });

  test("a broken catalogue leaves the built-in floors in place", async () => {
    const registered: any[] = [];
    const extension = createFreepiProviderExtension({
      path: "/nonexistent/freepi.json",
      readTokens: (async () => ({ version: 1 as const, tokens: records(1) })) as any,
      getCatalog: async () => {
        throw new Error("offline");
      },
    });
    await (extension as any).factory({
      registerProvider: (_name: string, config: any) => registered.push({ config }),
    } as any);
    const ids = registered[0].config.models.map((m: any) => m.id);
    expect(ids).toEqual(FREEPI_MODELS.map((m) => m.id));
  });
});

describe("freepiScopeIds", () => {
  test("the four ids when a token is saved", async () => {
    const pool = new FreepiTokenPool(records(1));
    expect(await freepiScopeIds(async () => pool)).toEqual([
      "particle",
      "deepseek-v4.1-flash",
      "glm-5.3-flash",
      "deepseek-v4-flash",
    ]);
  });

  test("nothing when no token is saved, so the picker advertises nothing", async () => {
    expect(await freepiScopeIds(async () => new FreepiTokenPool([]))).toEqual([]);
  });

  test("a pool that fails to load is the same as no pool", async () => {
    expect(
      await freepiScopeIds(async () => {
        throw new Error("broken token file");
      }),
    ).toEqual([]);
  });
});
