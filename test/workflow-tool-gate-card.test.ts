import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkflowToolExtension } from "../src/workflow-tool";
import { initExecutionMode, getExecutionMode, setExecutionMode } from "../src/execution-modes";
import type { SubagentRunner } from "../src/agent-tool";

const agentDir = () => mkdtempSync(join(tmpdir(), "qronos-gate-"));

/** A runner that asks its context to run one tool, then reports what it got. */
const act = (tool: string, args: Record<string, unknown>): SubagentRunner => async (params) => {
  const outcome = await (params.ctx as unknown as { executeTool: (name: string, args: unknown) => Promise<any> }).executeTool(tool, args);
  const text = String(outcome?.result?.content?.[0]?.text ?? "");
  return { ok: true, output: text, usage: { input: 1, output: 1, total: 2 } } as never;
};

interface Harness {
  execute: (params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; details: Record<string, any> }>;
  asks: Array<{ facts: { name: string; kind: string }; asked: number }>;
  keys: string[][];
  ran: string[];
  cards: number;
}

/** Build the real tool, with a fake model in the runner and a real overlay host. */
function harness(runner: SubagentRunner, keys: string[][] = []): Harness {
  const asks: Harness["asks"] = [];
  const ran: string[] = [];
  let cards = 0;
  let keyIndex = 0;
  const tool: { execute?: (...args: unknown[]) => Promise<any> } = {};
  const factory = (createWorkflowToolExtension({ runner, agentDir: agentDir(), config: { concurrency: 2, maxAgents: 4, wallClockMs: 30_000 } as never }) as unknown as { factory: (api: unknown) => void }).factory;
  factory({
    registerTool: (registered: Record<string, any>) => {
      tool.execute = registered.execute;
    },
    registerCommand: () => {},
    registerShortcut: () => {},
    sendMessage: () => {},
    on: () => {},
  } as never);

  const ctx = {
    cwd: process.cwd(),
    ui: {
      notify: () => {},
      setStatus: () => {},
      custom: async (build: any) => {
        cards += 1;
        const component = build({ requestRender: () => {} }, { fg: (_slot: string, text: string) => text }, {}, () => {});
        for (const key of keys[keyIndex] ?? []) component.handleInput(key);
        keyIndex += 1;
        return undefined;
      },
    },
    tools: [],
    executeTool: async (name: string, args: unknown) => {
      ran.push(`${name}:${JSON.stringify(args)}`);
      return { result: { content: [{ type: "text", text: `ran ${name}` }] }, isError: false };
    },
  };

  return {
    asks,
    ran,
    keys,
    get cards() {
      return cards;
    },
    execute: async (params) => tool.execute!(`call`, params, new AbortController().signal, () => {}, ctx),
  } as Harness;
}

const script = "return (await agent('do it', { label: 'one' })).text;";

describe("a tool inside a workflow meets the mode", () => {
  test("manual asks, and No means the tool never runs", async () => {
    initExecutionMode(false, "manual");
    const h = harness(act("bash", { command: "echo hi" }), [["\u001b"]]);
    const result = await h.execute({ script, background: false });
    expect(h.cards).toBe(1);
    expect(h.ran).toEqual([]);
    expect(result.content[0]!.text).toContain("No:");
  });

  test("manual asks, and Yes runs the tool", async () => {
    initExecutionMode(false, "manual");
    const h = harness(act("bash", { command: "echo hi" }), [["1"]]);
    const result = await h.execute({ script, background: false });
    expect(h.cards).toBe(1);
    expect(h.ran).toEqual(['bash:{"command":"echo hi"}']);
    expect(result.content[0]!.text).toContain("ran bash");
  });

  test("a read never asks, even in manual", async () => {
    initExecutionMode(false, "manual");
    const h = harness(act("read", { path: "a.ts" }));
    const result = await h.execute({ script, background: false });
    expect(h.cards).toBe(0);
    expect(h.ran.length).toBe(1);
    expect(result.content[0]!.text).toContain("ran read");
  });

  test("auto lets a plain command run without a card", async () => {
    initExecutionMode(false, "auto");
    const h = harness(act("bash", { command: "ls" }));
    await h.execute({ script, background: false });
    expect(h.cards).toBe(0);
    expect(h.ran.length).toBe(1);
  });

  test("auto stops at a destructive command", async () => {
    initExecutionMode(false, "auto");
    const h = harness(act("bash", { command: "rm -rf build" }), [["4"]]);
    await h.execute({ script, background: false });
    expect(h.cards).toBe(1);
    expect(h.ran).toEqual([]);
  });

  test("plan mode refuses a write without asking", async () => {
    initExecutionMode(false, "plan");
    const h = harness(act("write", { path: "src/a.ts", content: "x" }));
    const result = await h.execute({ script, background: false });
    expect(h.cards).toBe(0);
    expect(h.ran).toEqual([]);
    expect(result.content[0]!.text).toContain("plan mode");
  });

  test("allow-for-this-run stops the second card", async () => {
    initExecutionMode(false, "manual");
    // Two agents, the same shell tool: one card, two runs.
    const h = harness(act("bash", { command: "echo hi" }), [["2"]]);
    await h.execute({ script: "await agent('one'); await agent('two'); return 1;", background: false });
    expect(h.cards).toBe(1);
    expect(h.ran.length).toBe(2);
  });

  test("allow-for-this-run dies with the run", async () => {
    initExecutionMode(false, "manual");
    const h = harness(act("bash", { command: "echo hi" }), [["2"]]);
    await h.execute({ script, background: false });
    expect(h.cards).toBe(1);
    // A second run is a second run: it asks again.
    await h.execute({ script, background: false });
    expect(h.cards).toBe(2);
  });

  test("answer 3 switches the chat to auto", async () => {
    initExecutionMode(false, "manual");
    const h = harness(act("bash", { command: "echo hi" }), [["3"]]);
    await h.execute({ script, background: false });
    expect(getExecutionMode()).toBe("auto");
    expect(h.ran.length).toBe(1);
    setExecutionMode("auto");
  });

  test("no overlay host means no card and no tool", async () => {
    // A headless host has nowhere to draw a card. The answer is then No: silence
    // must never become a yes.
    initExecutionMode(false, "manual");
    const tool: { execute?: (...args: unknown[]) => Promise<any> } = {};
    let ran = 0;
    const factory = (
      createWorkflowToolExtension({
        runner: act("bash", { command: "echo hi" }),
        agentDir: agentDir(),
        config: { concurrency: 2, maxAgents: 4, wallClockMs: 30_000 } as never,
      }) as unknown as { factory: (api: unknown) => void }
    ).factory;
    factory({
      registerTool: (registered: Record<string, any>) => {
        tool.execute = registered.execute;
      },
      registerCommand: () => {},
      registerShortcut: () => {},
      sendMessage: () => {},
      on: () => {},
    } as never);

    const result = await tool.execute!(`call`, { script, background: false }, new AbortController().signal, () => {}, {
      cwd: process.cwd(),
      ui: { notify: () => {}, setStatus: () => {} },
      tools: [],
      executeTool: async () => {
        ran += 1;
        return { result: { content: [{ type: "text", text: "ran" }] }, isError: false };
      },
    });

    expect(ran).toBe(0);
    expect(result.content[0]!.text).toContain("No:");
  });
});
