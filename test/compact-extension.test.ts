import { describe, expect, test } from "bun:test";
import {
  COMPACT_STATUS_KEY,
  DEFAULT_COMPACT_TIMEOUT_MS,
  MIN_MESSAGES,
  compactConfigFromEnv,
  createCompactExtension,
  createCompactHandlers,
  resolveCompactModel,
  type CompactConfig,
} from "../src/compact-extension";
import { compactStatusLine } from "../src/compact-summary";

const goodSummary = `## Goal
Fix the login flow.

## Constraints & Preferences
- bun only

## Progress
- [x] reproduced it

## Key Decisions
- **keep the API**: the UI calls it

## Errors & Open Questions
- (none)

## Next Steps
1. write the test

## Critical Context
- src/auth.ts`;

const chatModel = { provider: "qronos", id: "glm-5.3-flash" } as never;

function makeCtx(overrides: Record<string, unknown> = {}) {
  const statuses: Array<{ key: string; text?: string }> = [];
  return {
    cwd: "/repo",
    model: chatModel,
    modelRegistry: {
      find: () => undefined,
      getModelsOfType: () => [chatModel],
      getApiKeyAndHeaders: async () => ({ apiKey: "k", headers: {} }),
    },
    ui: { setStatus: (key: string, text?: string) => statuses.push({ key, text }) },
    statuses,
    ...overrides,
  } as never;
}

interface Prepare {
  messagesToSummarize: unknown[];
  turnPrefixMessages: unknown[];
  firstKeptEntryId?: string;
  tokensBefore: number;
  previousSummary?: string;
  isSplitTurn: boolean;
}

function event(messages = 8): { preparation: Prepare; reason: string; customInstructions?: string } {
  const turns: unknown[] = [];
  for (let index = 0; index < messages; index += 1) {
    turns.push(
      index % 2 === 0
        ? { role: "user", content: [{ type: "text", text: `request ${index}` }] }
        : { role: "assistant", content: [{ type: "text", text: `answer ${index}` }] },
    );
  }
  return {
    preparation: {
      messagesToSummarize: turns,
      turnPrefixMessages: [],
      firstKeptEntryId: "entry-42",
      tokensBefore: 48_000,
      previousSummary: undefined,
      isSplitTurn: false,
    },
    reason: "manual",
    customInstructions: undefined,
  };
}

const config = (overrides: Partial<CompactConfig> = {}): CompactConfig => ({
  enabled: true,
  timeoutMs: DEFAULT_COMPACT_TIMEOUT_MS,
  minMessages: MIN_MESSAGES,
  ...overrides,
});

const answerWith = (text: string) => async () => text;

describe("config", () => {
  test("is on by default", () => {
    expect(compactConfigFromEnv({}).enabled).toBe(true);
  });

  test("QRONOS_COMPACT=0 turns it off", () => {
    expect(compactConfigFromEnv({ QRONOS_COMPACT: "0" }).enabled).toBe(false);
    expect(compactConfigFromEnv({ QRONOS_COMPACT: "false" }).enabled).toBe(false);
  });

  test("reads the model override", () => {
    expect(compactConfigFromEnv({ QRONOS_COMPACT_MODEL: "glm-5.3-flash" }).model).toBe("glm-5.3-flash");
  });

  test("ignores a silly timeout", () => {
    expect(compactConfigFromEnv({ QRONOS_COMPACT_TIMEOUT_MS: "5" }).timeoutMs).toBe(DEFAULT_COMPACT_TIMEOUT_MS);
    expect(compactConfigFromEnv({ QRONOS_COMPACT_TIMEOUT_MS: "nope" }).timeoutMs).toBe(DEFAULT_COMPACT_TIMEOUT_MS);
  });

  test("accepts a longer timeout", () => {
    expect(compactConfigFromEnv({ QRONOS_COMPACT_TIMEOUT_MS: "20000" }).timeoutMs).toBe(20_000);
  });
});

describe("the summary handler", () => {
  test("returns a compaction with a summary and the kept boundary", async () => {
    const handlers = createCompactHandlers({ config: config(), complete: answerWith(goodSummary) });
    const result = (await handlers.summarize(event(), makeCtx())) as {
      compaction?: { summary: string; firstKeptEntryId: string; estimatedTokensAfter: number; details: unknown };
    };
    expect(result.compaction?.summary).toContain("Fix the login flow");
    expect(result.compaction?.firstKeptEntryId).toBe("entry-42");
    expect(result.compaction?.estimatedTokensAfter).toBeGreaterThan(0);
    expect(result.compaction?.details).toMatchObject({ source: "qronos-compact" });
  });

  test("appends the recorded facts a model tends to paraphrase away", async () => {
    const handlers = createCompactHandlers({ config: config(), complete: answerWith(goodSummary) });
    const input = event();
    input.preparation.messagesToSummarize.push({
      role: "assistant",
      content: [{ type: "toolCall", name: "edit", arguments: { path: "/repo/src/auth.ts" } }],
    });
    const result = (await handlers.summarize(input, makeCtx())) as { compaction?: { summary: string } };
    expect(result.compaction?.summary).toContain("## Exact Evidence");
    expect(result.compaction?.summary).toContain("src/auth.ts");
  });

  test("records stats and evidence in details", async () => {
    const handlers = createCompactHandlers({ config: config(), complete: answerWith(goodSummary) });
    const result = (await handlers.summarize(event(), makeCtx())) as {
      compaction?: { details: { evidence: { files: string[] }; stats: { messages: number } } };
    };
    expect(result.compaction?.details.stats.messages).toBe(8);
    expect(Array.isArray(result.compaction?.details.evidence.files)).toBe(true);
  });

  test("sets a status line that shows the saving", async () => {
    const handlers = createCompactHandlers({ config: config(), complete: answerWith(goodSummary) });
    const ctx = makeCtx();
    await handlers.summarize(event(), ctx);
    const status = (ctx as unknown as { statuses: Array<{ key: string; text?: string }> }).statuses.at(-1);
    expect(status?.key).toBe(COMPACT_STATUS_KEY);
    expect(status?.text).toContain("compacted");
  });

  test("a bad answer falls back to the built-in path", async () => {
    const handlers = createCompactHandlers({ config: config(), complete: answerWith("I think it is all fine.") });
    const ctx = makeCtx();
    expect(await handlers.summarize(event(), ctx)).toEqual({});
    const status = (ctx as unknown as { statuses: Array<{ text?: string }> }).statuses.at(-1);
    expect(status?.text).toContain("kept built-in");
  });

  test("a model error falls back instead of failing the turn", async () => {
    const handlers = createCompactHandlers({
      config: config(),
      complete: async () => {
        throw new Error("upstream 503");
      },
    });
    const ctx = makeCtx();
    expect(await handlers.summarize(event(), ctx)).toEqual({});
    expect((ctx as unknown as { statuses: Array<{ text?: string }> }).statuses.at(-1)?.text).toContain("503");
  });

  test("a timeout falls back", async () => {
    const handlers = createCompactHandlers({
      config: config({ timeoutMs: 10_000 }),
      complete: () => new Promise<string>(() => {}),
      timeout: async () => {
        throw new Error("timeout after 10000ms");
      },
    });
    const ctx = makeCtx();
    expect(await handlers.summarize(event(), ctx)).toEqual({});
  });

  test("a tiny history is left to pi", async () => {
    let called = false;
    const handlers = createCompactHandlers({
      config: config(),
      complete: async () => {
        called = true;
        return goodSummary;
      },
    });
    expect(await handlers.summarize(event(2), makeCtx())).toEqual({});
    expect(called).toBe(false);
  });

  test("no boundary means no summary", async () => {
    const handlers = createCompactHandlers({ config: config(), complete: answerWith(goodSummary) });
    const input = event();
    input.preparation.firstKeptEntryId = undefined;
    expect(await handlers.summarize(input, makeCtx())).toEqual({});
  });

  test("a disabled extension never calls a model", async () => {
    let called = false;
    const handlers = createCompactHandlers({
      config: config({ enabled: false }),
      complete: async () => {
        called = true;
        return goodSummary;
      },
    });
    expect(await handlers.summarize(event(), makeCtx())).toEqual({});
    expect(called).toBe(false);
  });

  test("split-turn prefix messages are summarised too", async () => {
    const handlers = createCompactHandlers({
      config: config(),
      complete: async (_model, _system, prompt) => {
        expect(prompt).toContain("HALF-A-TURN");
        return goodSummary;
      },
    });
    const input = event();
    input.preparation.turnPrefixMessages = [{ role: "user", content: [{ type: "text", text: "HALF-A-TURN" }] }];
    await handlers.summarize(input, makeCtx());
  });

  test("the prompt carries the previous checkpoint", async () => {
    const handlers = createCompactHandlers({
      config: config(),
      complete: async (_model, _system, prompt) => {
        expect(prompt).toContain("EARLIER-GOAL");
        return goodSummary;
      },
    });
    const input = event();
    input.preparation.previousSummary = "## Goal\nEARLIER-GOAL";
    await handlers.summarize(input, makeCtx());
  });

  test("no auth still tries: a local model may need none", async () => {
    const handlers = createCompactHandlers({ config: config(), complete: answerWith(goodSummary) });
    const ctx = makeCtx({
      modelRegistry: { find: () => undefined, getModelsOfType: () => [], getApiKeyAndHeaders: async () => { throw new Error("no auth"); } },
    });
    const result = (await handlers.summarize(event(), ctx)) as { compaction?: unknown };
    expect(result.compaction).toBeDefined();
  });
});

describe("resolveCompactModel", () => {
  test("defaults to the session model", () => {
    expect(resolveCompactModel(compactConfigFromEnv({}), chatModel, undefined)).toBe(chatModel);
  });

  test("finds a named model in the registry", () => {
    const other = { provider: "qronos", id: "cheap" } as never;
    const registry = {
      find: (provider: string, id: string) => (id === "cheap" ? other : undefined),
      getModelsOfType: () => [other],
    } as never;
    expect(resolveCompactModel(compactConfigFromEnv({ QRONOS_COMPACT_MODEL: "cheap" }), chatModel, registry)).toBe(other);
  });

  test("an unknown name keeps the session model instead of turning compaction off", () => {
    const registry = { find: () => undefined, getModelsOfType: () => [] } as never;
    expect(resolveCompactModel(compactConfigFromEnv({ QRONOS_COMPACT_MODEL: "ghost" }), chatModel, registry)).toBe(chatModel);
  });
});

describe("the pi wiring", () => {
  test("registers under the documented name and listens to compaction events", () => {
    const registered: string[] = [];
    const extension = createCompactExtension({ config: config(), complete: answerWith(goodSummary) });
    expect(extension.name).toBe("qronos-compact");
    (extension as unknown as { factory: (api: unknown) => void }).factory({
      on: (name: string) => registered.push(name),
    });
    expect(registered).toEqual(["session_before_compact", "session_compact_failed"]);
  });

  test("the handler is wired to the same core", async () => {
    let seen = "";
    const extension = createCompactExtension({
      config: config(),
      complete: async (_model, _system, prompt) => {
        seen = prompt;
        return goodSummary;
      },
    });
    const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
    (extension as unknown as { factory: (api: unknown) => void }).factory({
      on: (name: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => handlers.set(name, handler),
    });
    const result = (await handlers.get("session_before_compact")!(event(), makeCtx())) as { compaction?: unknown };
    expect(result.compaction).toBeDefined();
    expect(seen).toContain("<conversation>");
  });

  test("status text matches the documented format", () => {
    expect(compactStatusLine(100_000, 5_000)).toBe("compacted 100k → 1.3k tokens");
  });
});