import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MEMORY_CONFIG, type MemoryConfig } from "../src/memory-config";
import { MEMORY_SECTION } from "../src/memory-inject";
import { memoryFiles } from "../src/memory-paths";
import { readJournal, readState, readText, writeAtomic } from "../src/memory-store";
import { AUTO_SYNC_DELAY_MS, MEMORY_STATUS_KEY, createMemoryExtension, toolFileArgs } from "../src/memory-extension";

/* -------------------------------------------------------------------------- */
/* A tiny fake of the pi extension surface, big enough to drive the handlers.  */
/* -------------------------------------------------------------------------- */

type Handler = (event: Record<string, unknown>, ctx: FakeCtx) => Promise<unknown> | unknown;

interface FakeCtx {
  cwd: string;
  model: { provider: string; id: string };
  modelRegistry: {
    find(provider: string, id: string): unknown;
    getModelsOfType(type: string): Array<{ id?: string }>;
    getApiKeyAndHeaders(): Promise<{ apiKey?: string; headers?: Record<string, string> }>;
  };
  ui: {
    notify: (message: string, type?: string) => void;
    setStatus: (key: string, text?: string) => void;
    confirm: (title: string, message: string) => Promise<boolean>;
  };
  notices: Array<{ message: string; type?: string }>;
  statuses: Array<{ key: string; text?: string }>;
}

function makeCtx(cwd: string): FakeCtx {
  const notices: Array<{ message: string; type?: string }> = [];
  const statuses: Array<{ key: string; text?: string }> = [];
  return {
    cwd,
    model: { provider: "qronos", id: "glm-5.3-flash" },
    modelRegistry: {
      find: () => undefined,
      getModelsOfType: () => [],
      getApiKeyAndHeaders: async () => ({}),
    },
    ui: {
      notify: (message, type) => notices.push({ message, type }),
      setStatus: (key, text) => statuses.push({ key, text }),
      confirm: async () => true,
    },
    notices,
    statuses,
  };
}

interface Harness {
  handlers: Map<string, Handler[]>;
  tools: Array<Record<string, unknown>>;
  commands: Map<string, { handler: (args: string, ctx: FakeCtx) => Promise<void> }>;
  emit(name: string, event: Record<string, unknown>, ctx: FakeCtx): Promise<void>;
}

function buildHarness(options: Parameters<typeof createMemoryExtension>[0]): Harness {
  const extension = createMemoryExtension(options);
  const handlers = new Map<string, Handler[]>();
  const tools: Array<Record<string, unknown>> = [];
  const commands = new Map<string, { handler: (args: string, ctx: FakeCtx) => Promise<void> }>();
  const api = {
    on(name: string, handler: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerTool(tool: Record<string, unknown>) {
      tools.push(tool);
    },
    registerCommand(name: string, command: { handler: (args: string, ctx: FakeCtx) => Promise<void> }) {
      commands.set(name, command);
    },
  };
  const factory = (extension as unknown as { factory: (qronos: unknown) => void }).factory;
  factory(api);
  return {
    handlers,
    tools,
    commands,
    async emit(name, event, ctx) {
      for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
    },
  };
}

/* -------------------------------------------------------------------------- */

let dir: string;
let cwd: string;
const now = () => 1_700_000_000_000;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qronos-memory-ext-"));
  cwd = join(dir, "app");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function paths() {
  return memoryFiles(dir, cwd, cwd);
}

function config(overrides: Partial<MemoryConfig> = {}): MemoryConfig {
  return { ...DEFAULT_MEMORY_CONFIG, ...overrides };
}

const turnEvent = (prompt: string, answer: string) => ({
  message: { role: "assistant", content: [{ type: "text", text: answer }] },
  toolResults: [],
  prompt,
});

describe("wiring", () => {
  test("the extension has the documented name and registers a tool and a command", () => {
    const harness = buildHarness({ config: config(), agentDir: dir, now });
    expect(createMemoryExtension({ config: config(), agentDir: dir }).name).toBe("qronos-memory");
    expect(harness.tools.map((tool) => tool.name)).toEqual(["learn"]);
    expect([...harness.commands.keys()]).toEqual(["memory"]);
  });

  test("a disabled extension registers but does nothing", async () => {
    const harness = buildHarness({ config: config({ enabled: false }), agentDir: dir, now });
    const ctx = makeCtx(cwd);
    await harness.emit("session_start", { reason: "startup" }, ctx);
    await harness.emit("turn_end", turnEvent("hi", "there"), ctx);
    expect(ctx.statuses).toEqual([]);
    expect(readJournal(paths())).toEqual([]);
  });
});

describe("session_start", () => {
  test("no memory yet sets no status line", async () => {
    const harness = buildHarness({ config: config({ auto: false }), agentDir: dir, now });
    const ctx = makeCtx(cwd);
    await harness.emit("session_start", { reason: "startup" }, ctx);
    expect(ctx.statuses.every((entry) => entry.text === undefined)).toBe(true);
  });

  test("existing memory shows a status line with a count", async () => {
    writeAtomic(paths().doc, "# Memory\n\n## Decisions\n- use bun\n- no new tables\n");
    const harness = buildHarness({ config: config({ auto: false }), agentDir: dir, now });
    const ctx = makeCtx(cwd);
    await harness.emit("session_start", { reason: "startup" }, ctx);
    const status = ctx.statuses.filter((entry) => entry.key === MEMORY_STATUS_KEY).at(-1);
    expect(status?.text).toBe("memory 2");
  });

  test("the background sync is scheduled after the documented delay", async () => {
    let delay = -1;
    const ctx = makeCtx(cwd);
    const harness = buildHarness({
      config: config({ auto: true }),
      agentDir: dir,
      now,
      setTimer: (_fn, ms) => {
        delay = ms;
        return { unref: () => {} };
      },
    });
    await harness.emit("session_start", { reason: "startup" }, ctx);
    expect(delay).toBe(AUTO_SYNC_DELAY_MS);
  });
});

describe("before_agent_start", () => {
  test("memory is injected as its own section", async () => {
    writeAtomic(paths().doc, "# Memory\n\n## Decisions\n- use bun for scripts\n");
    const harness = buildHarness({ config: config({ auto: false }), agentDir: dir, now });
    const event = { prompt: "hello", systemPromptOptions: {} as { sections?: Record<string, string> } };
    await harness.emit("before_agent_start", event, makeCtx(cwd));
    expect(event.systemPromptOptions.sections?.[MEMORY_SECTION]).toContain("use bun for scripts");
  });

  test("no memory means no section at all", async () => {
    const harness = buildHarness({ config: config({ auto: false }), agentDir: dir, now });
    const event = { prompt: "hello", systemPromptOptions: {} as { sections?: Record<string, string> } };
    await harness.emit("before_agent_start", event, makeCtx(cwd));
    expect(event.systemPromptOptions.sections?.[MEMORY_SECTION]).toBeUndefined();
  });

  test("other sections are preserved", async () => {
    writeAtomic(paths().doc, "# Memory\n\n## Decisions\n- keep me\n");
    const harness = buildHarness({ config: config({ auto: false }), agentDir: dir, now });
    const event = {
      prompt: "hello",
      systemPromptOptions: { sections: { "stream-rules": "existing" } } as { sections?: Record<string, string> },
    };
    await harness.emit("before_agent_start", event, makeCtx(cwd));
    expect(event.systemPromptOptions.sections?.["stream-rules"]).toBe("existing");
  });
});

describe("turn_end journaling", () => {
  test("a finished turn is written with its prompt and answer", async () => {
    const harness = buildHarness({ config: config({ auto: false }), agentDir: dir, now });
    const ctx = makeCtx(cwd);
    await harness.emit("before_agent_start", { prompt: "fix the test", systemPromptOptions: {} }, ctx);
    await harness.emit("turn_end", turnEvent("fix the test", "fixed it"), ctx);
    const journal = readJournal(paths());
    expect(journal).toHaveLength(1);
    expect(journal[0]!.prompt).toBe("fix the test");
    expect(journal[0]!.answer).toBe("fixed it");
    expect(journal[0]!.outcome).toBe("ok");
  });

  test("files and tools from the turn are recorded", async () => {
    const harness = buildHarness({ config: config({ auto: false }), agentDir: dir, now });
    const ctx = makeCtx(cwd);
    await harness.emit("before_agent_start", { prompt: "edit", systemPromptOptions: {} }, ctx);
    await harness.emit("tool_execution_start", { toolName: "edit", args: { path: `${cwd}/src/a.ts` } }, ctx);
    await harness.emit("turn_end", turnEvent("edit", "done"), ctx);
    const row = readJournal(paths())[0]!;
    expect(row.tools).toContain("edit");
    expect(row.files).toContain("src/a.ts");
  });

  test("a failed tool marks the turn as an error", async () => {
    const harness = buildHarness({ config: config({ auto: false }), agentDir: dir, now });
    const ctx = makeCtx(cwd);
    await harness.emit("before_agent_start", { prompt: "run", systemPromptOptions: {} }, ctx);
    await harness.emit(
      "turn_end",
      { message: { content: [{ type: "text", text: "it broke" }] }, toolResults: [{ isError: true }] },
      ctx,
    );
    expect(readJournal(paths())[0]!.outcome).toBe("error");
  });

  test("the turn counter is kept in state", async () => {
    const harness = buildHarness({ config: config({ auto: false }), agentDir: dir, now });
    const ctx = makeCtx(cwd);
    await harness.emit("before_agent_start", { prompt: "one", systemPromptOptions: {} }, ctx);
    await harness.emit("turn_end", turnEvent("one", "first"), ctx);
    expect(readState(paths()).turns).toBe(1);
  });

  test("an empty turn is not journaled", async () => {
    const harness = buildHarness({ config: config({ auto: false }), agentDir: dir, now });
    const ctx = makeCtx(cwd);
    await harness.emit("turn_end", { message: { content: [] }, toolResults: [] }, ctx);
    expect(readJournal(paths())).toEqual([]);
  });

  test("a secret in the prompt never reaches the journal", async () => {
    const harness = buildHarness({ config: config({ auto: false }), agentDir: dir, now });
    const ctx = makeCtx(cwd);
    await harness.emit("before_agent_start", { prompt: "my key is AKIAIOSFODNN7EXAMPLE", systemPromptOptions: {} }, ctx);
    await harness.emit("turn_end", turnEvent("x", "noted"), ctx);
    expect(readJournal(paths())[0]!.prompt).not.toContain("AKIA");
  });
});

describe("the learn tool", () => {
  const learnTool = (harness: Harness) => harness.tools[0] as {
    execute: (
      id: string,
      params: { lesson: string },
      signal: undefined,
      onUpdate: undefined,
      ctx: FakeCtx,
    ) => Promise<{ content: Array<{ text: string }>; isError?: boolean; details: Record<string, unknown> }>;
  };

  test("saves a lesson and reports the count", async () => {
    const harness = buildHarness({ config: config(), agentDir: dir, now });
    const result = await learnTool(harness).execute("1", { lesson: "run the suite with --bail" }, undefined, undefined, makeCtx(cwd));
    expect(result.content[0]!.text).toContain("Saved");
    expect(readText(paths().lessons)).toContain("run the suite with --bail");
  });

  test("a duplicate is refused", async () => {
    const harness = buildHarness({ config: config(), agentDir: dir, now });
    const tool = learnTool(harness);
    await tool.execute("1", { lesson: "use bun" }, undefined, undefined, makeCtx(cwd));
    const second = await tool.execute("2", { lesson: "Use bun." }, undefined, undefined, makeCtx(cwd));
    expect(second.content[0]!.text).toContain("already known");
    expect(second.details.saved).toBe(false);
  });

  test("an empty lesson is refused", async () => {
    const harness = buildHarness({ config: config(), agentDir: dir, now });
    const result = await learnTool(harness).execute("1", { lesson: "  " }, undefined, undefined, makeCtx(cwd));
    expect(result.details.saved).toBe(false);
  });

  test("a disabled extension refuses politely", async () => {
    const harness = buildHarness({ config: config({ enabled: false }), agentDir: dir, now });
    const result = await learnTool(harness).execute("1", { lesson: "x" }, undefined, undefined, makeCtx(cwd));
    expect(result.content[0]!.text).toContain("turned off");
    expect(result.isError).toBeUndefined();
  });

  test("the status line is refreshed after a lesson", async () => {
    const harness = buildHarness({ config: config(), agentDir: dir, now });
    const ctx = makeCtx(cwd);
    await learnTool(harness).execute("1", { lesson: "use bun" }, undefined, undefined, ctx);
    expect(ctx.statuses.at(-1)?.text).toBe("memory 1");
  });
});

describe("/memory command", () => {
  test("view says nothing is known yet on a fresh project", async () => {
    const harness = buildHarness({ config: config({ auto: false }), agentDir: dir, now });
    const ctx = makeCtx(cwd);
    await harness.commands.get("memory")!.handler("view", ctx);
    expect(ctx.notices[0]!.message).toContain("Nothing learned");
  });

  test("view prints the injected block once memory exists", async () => {
    writeAtomic(paths().doc, "# Memory\n\n## Decisions\n- use bun\n");
    const harness = buildHarness({ config: config({ auto: false }), agentDir: dir, now });
    const ctx = makeCtx(cwd);
    await harness.commands.get("memory")!.handler("view", ctx);
    expect(ctx.notices[0]!.message).toContain("use bun");
  });

  test("stats reports counts, syncs and the journal backlog", async () => {
    writeAtomic(paths().lessons, "# Lessons\n\n- [2026-01-01] a lesson\n");
    const harness = buildHarness({ config: config({ auto: false }), agentDir: dir, now });
    const ctx = makeCtx(cwd);
    await harness.commands.get("memory")!.handler("stats", ctx);
    const text = ctx.notices[0]!.message;
    expect(text).toContain("Project:");
    expect(text).toContain("lesson(s)");
    expect(text).toContain("Budget:");
  });

  test("add saves a lesson, forget removes it", async () => {
    const harness = buildHarness({ config: config({ auto: false }), agentDir: dir, now });
    const ctx = makeCtx(cwd);
    await harness.commands.get("memory")!.handler("add always run bun test", ctx);
    expect(readText(paths().lessons)).toContain("always run bun test");
    await harness.commands.get("memory")!.handler("forget bun", ctx);
    expect(readText(paths().lessons)).not.toContain("always run bun test");
  });

  test("clear asks first and then empties the memory", async () => {
    writeAtomic(paths().doc, "# Memory\n\n## Decisions\n- something\n");
    writeAtomic(paths().lessons, "# Lessons\n\n- [2026-01-01] something else\n");
    const harness = buildHarness({ config: config({ auto: false }), agentDir: dir, now });
    const ctx = makeCtx(cwd);
    await harness.commands.get("memory")!.handler("clear", ctx);
    expect(readText(paths().lessons)?.trim()).toBe("");
    expect(readText(paths().doc)).toContain("Nothing learned yet");
  });

  test("an unknown subcommand prints usage", async () => {
    const harness = buildHarness({ config: config({ auto: false }), agentDir: dir, now });
    const ctx = makeCtx(cwd);
    await harness.commands.get("memory")!.handler("wat", ctx);
    expect(ctx.notices[0]!.message).toContain("Usage:");
  });

  test("a disabled extension explains how to re-enable", async () => {
    const harness = buildHarness({ config: config({ enabled: false }), agentDir: dir, now });
    const ctx = makeCtx(cwd);
    await harness.commands.get("memory")!.handler("view", ctx);
    expect(ctx.notices[0]!.message).toContain("QRONOS_MEMORY=0");
  });
});

describe("automatic sync", () => {
  test("enough new turns produces a document without a manual command", async () => {
    const harness = buildHarness({
      config: config({ auto: true, minTurns: 1 }),
      agentDir: dir,
      now,
      extract: async () => JSON.stringify({ decisions: ["An automatic decision that is long enough"] }),
      setTimer: (fn) => {
        void fn();
        return { unref: () => {} };
      },
    });
    const ctx = makeCtx(cwd);
    await harness.emit("before_agent_start", { prompt: "build it", systemPromptOptions: {} }, ctx);
    await harness.emit("turn_end", turnEvent("build it", "built"), ctx);
    await harness.emit("session_start", { reason: "startup" }, ctx);
    // The timer ran synchronously; give the async pipeline a tick to finish.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(readText(paths().doc)).toContain("An automatic decision");
  });

  test("a model failure during the automatic sync stays silent and keeps memory", async () => {
    writeAtomic(paths().doc, "# Memory\n\n## Decisions\n- keep me safe\n");
    const harness = buildHarness({
      config: config({ auto: true, minTurns: 1 }),
      agentDir: dir,
      now,
      extract: async () => {
        throw new Error("boom");
      },
      setTimer: (fn) => {
        void fn();
        return { unref: () => {} };
      },
    });
    const ctx = makeCtx(cwd);
    await harness.emit("before_agent_start", { prompt: "build it", systemPromptOptions: {} }, ctx);
    await harness.emit("turn_end", turnEvent("build it", "built"), ctx);
    await harness.emit("session_start", { reason: "startup" }, ctx);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(readText(paths().doc)).toContain("keep me safe");
    // No error notice reached the user.
    expect(ctx.notices).toEqual([]);
  });
});

describe("toolFileArgs", () => {
  test("reads the usual path keys", () => {
    expect(toolFileArgs({ path: "a.ts", file_path: "b.ts", files: ["c.ts"] })).toEqual(["a.ts", "b.ts", "c.ts"]);
  });

  test("reads hashline patch headers", () => {
    expect(toolFileArgs({ patch: "*** Begin Patch\n[src/a.ts#1a2b]\nPUT 1.=1:\n+x\n*** End Patch" })).toEqual(["src/a.ts"]);
  });

  test("ignores a non-object argument", () => {
    expect(toolFileArgs("nope")).toEqual([]);
    expect(toolFileArgs(undefined)).toEqual([]);
  });
});
