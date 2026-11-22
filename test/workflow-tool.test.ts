import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  WORKFLOW_TOOL_NAME,
  createWorkflowToolExtension,
  getLastWorkflowRun,
  renderWorkflowDetail,
  renderJobDetail,
  renderWorkflowReport,
  resetLastWorkflowRun,
  resetWorkflowJobs,
} from "../src/workflow-tool";
import { workflowConfigFromEnv, type WorkflowRunResult } from "../src/workflow-types";
import { WorkflowJobManager } from "../src/workflow-jobs";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SubagentRunner } from "../src/agent-tool";

/** A fake subagent runner: no model, no wait, records every prompt. */
function fakeRunner(answer?: (prompt: string) => Partial<Awaited<ReturnType<SubagentRunner>>>) {
  const prompts: string[] = [];
  const runner: SubagentRunner = async (params) => {
    prompts.push(params.prompt);
    const extra = answer?.(params.prompt) ?? {};
    return { output: `report for: ${params.prompt}`, turns: 1, toolsUsed: [], ...extra };
  };
  return { prompts, runner };
}

/** Minimal fake pi API: captures the registered tool so tests can call it. */
function fakePi() {
  const tools: Array<Record<string, unknown>> = [];
  return {
    tools,
    api: {
      registerTool: (tool: Record<string, unknown>) => tools.push(tool),
      registerCommand: () => {},
      registerShortcut: () => {},
      sendMessage: () => {},
      on: () => {},
    } as never,
  };
}

const ctx = { cwd: "/repo" } as never;

afterEach(() => {
  resetLastWorkflowRun();
  resetWorkflowJobs();
});


describe("the detail of a job that was restarted", () => {
  test("the token line is rebuilt from the job, not from the settled snapshot", async () => {
    // With a real usage number, so the second attempt really costs more.
    const { runner } = fakeRunner(() => ({ usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 } }));
    const manager = new WorkflowJobManager({ runAgent: runner as never, config: workflowConfigFromEnv({}), agentDir: mkdtempSync(join(tmpdir(), "qronos-tool-")) });
    const job = manager.launch({ script: "await agent('one'); return 1;" });
    await job.settled;
    const before = renderJobDetail(job);
    await manager.restartAgent(job.id, job.agents[0]!.id);
    const after = renderJobDetail(job);
    // A detail line that still showed the old count would hide the second charge.
    expect(after).not.toBe(before);
    expect(after).toContain("30 tokens");
  });
});


/** Run the tool once with the given params and a fake runner. */
async function runTool(options: { runner: SubagentRunner }, params: Record<string, unknown>) {
  const { tools, api } = fakePi();
  (createWorkflowToolExtension({ runner: options.runner, agentDir: mkdtempSync(join(tmpdir(), "qronos-wf-file-")) }) as unknown as { factory: (api: unknown) => void }).factory(api);
  const tool = tools[0] as { execute: Function };
  return tool.execute("1", params, undefined, undefined, ctx);
}

describe("a script saved on disk", () => {
  let dir = "";
  let real = "";

  beforeEach(() => {
    real = process.cwd();
    dir = mkdtempSync(join(tmpdir(), "qronos-scriptfile-"));
    mkdirSync(join(dir, ".qronos", "workflows"), { recursive: true });
    writeFileSync(join(dir, ".qronos", "workflows", "saved-one.js"), "await agent('hello'); return 1;\n");
    process.chdir(dir);
  });

  afterEach(() => {
    process.chdir(real);
  });

  test("scriptFile runs the text that is on disk, and the name comes from the file", async () => {
    const { runner, prompts } = fakeRunner();
    const job = await runTool({ runner }, { scriptFile: "saved-one", background: false });
    expect(job.details.ok).toBe(true);
    expect(prompts).toEqual(["hello"]);
    expect(job.details.name).toBe("saved-one");
  });

  test("a path works as well as a name", async () => {
    const { runner, prompts } = fakeRunner();
    const job = await runTool({ runner }, { scriptFile: join(dir, ".qronos", "workflows", "saved-one.js"), background: false });
    expect(prompts.length).toBe(1);
    expect(job.details.name).toBe("saved-one");
  });

  test("an unknown name is refused before anything runs", async () => {
    const { runner, prompts } = fakeRunner();
    const job = await runTool({ runner }, { scriptFile: "nope", background: false });
    expect(job.details.ok).toBe(false);
    expect(prompts).toEqual([]);
    expect(job.content[0]!.text).toContain("no saved script");
  });

  test("an empty file is refused with its own reason", async () => {
    writeFileSync(join(dir, ".qronos", "workflows", "empty.js"), "  \n");
    const { runner } = fakeRunner();
    const job = await runTool({ runner }, { scriptFile: "empty", background: false });
    expect(job.details.ok).toBe(false);
    expect(job.content[0]!.text).toContain("the file is empty");
  });

  test("no script, no id and no file is still an error", async () => {
    const { runner } = fakeRunner();
    const job = await runTool({ runner }, { background: false });
    expect(job.details.ok).toBe(false);
    expect(job.content[0]!.text).toContain("scriptFile");
  });
});

describe("the tool", () => {
  test("registers a tool named workflow", () => {
    const { tools, api } = fakePi();
    (    createWorkflowToolExtension({ runner: fakeRunner().runner, agentDir: "/tmp/qronos-wf-test" }) as unknown as { factory: (api: unknown) => void }).factory(api);
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe(WORKFLOW_TOOL_NAME);
  });

  test("runs a script and returns only the final value", async () => {
    const { prompts, runner } = fakeRunner();
    const { tools, api } = fakePi();
    (    createWorkflowToolExtension({ runner, agentDir: "/tmp/qronos-wf-test" }) as unknown as { factory: (api: unknown) => void }).factory(api);
    const tool = tools[0] as { execute: Function };
    const result = await tool.execute("1", { background: false, script: `const r = await agent("look at src/"); return r.text;` }, undefined, undefined, ctx);
    expect(result.details.ok).toBe(true);
    expect(result.content[0].text).toContain("report for: look at src/");
    expect(result.content[0].text).toContain("1 agent in");
    expect(prompts).toEqual(["look at src/"]);
  });

  test("an empty script is refused before any agent runs", async () => {
    const { prompts, runner } = fakeRunner();
    const { tools, api } = fakePi();
    (    createWorkflowToolExtension({ runner, agentDir: "/tmp/qronos-wf-test" }) as unknown as { factory: (api: unknown) => void }).factory(api);
    const tool = tools[0] as { execute: Function };
    const result = await tool.execute("1", { background: false, script: "   " }, undefined, undefined, ctx);
    expect(result.details.ok).toBe(false);
    expect(prompts).toHaveLength(0);
  });

  test("a schema answer becomes data", async () => {
    const { runner } = fakeRunner(() => ({
      output: '{"files":["a.ts"]}',
      structured: { value: { files: ["a.ts"] }, firstTry: true },
    }));
    const { tools, api } = fakePi();
    (    createWorkflowToolExtension({ runner, agentDir: "/tmp/qronos-wf-test" }) as unknown as { factory: (api: unknown) => void }).factory(api);
    const tool = tools[0] as { execute: Function };
    const result = await tool.execute(
      "1",
      {
        background: false,
        script: `const r = await agent("list", { schema: { type: "object", properties: { files: { type: "array" } } } }); return r.data.files;`,
      },
      undefined,
      undefined,
      ctx,
    );
    expect(result.details.ok).toBe(true);
    expect(result.content[0].text).toContain("a.ts");
  });

  test("a schema mismatch is a failed agent, not a crash", async () => {
    const { runner } = fakeRunner(() => ({
      output: "not json",
      schemaIssues: [{ path: "files", message: "is required" }],
    }));
    const { tools, api } = fakePi();
    (    createWorkflowToolExtension({ runner, agentDir: "/tmp/qronos-wf-test" }) as unknown as { factory: (api: unknown) => void }).factory(api);
    const tool = tools[0] as { execute: Function };
    const result = await tool.execute("1", { background: false, script: `await agent("list", { schema: { type: "object" } }); return 1;` }, undefined, undefined, ctx);
    expect(result.details.ok).toBe(true);
    expect(result.content[0].text).toContain("1 failed");
  });

  test("a runner that throws does not break the tool", async () => {
    const runner: SubagentRunner = async () => {
      throw new Error("the model died");
    };
    const { tools, api } = fakePi();
    (    createWorkflowToolExtension({ runner, agentDir: "/tmp/qronos-wf-test" }) as unknown as { factory: (api: unknown) => void }).factory(api);
    const tool = tools[0] as { execute: Function };
    const result = await tool.execute("1", { background: false, script: `const r = await agent("x"); return r.error;` }, undefined, undefined, ctx);
    expect(result.details.ok).toBe(true);
    expect(result.content[0].text).toContain("the model died");
  });

  test("the name from the call wins, then the meta block", async () => {
    const { runner } = fakeRunner();
    const { tools, api } = fakePi();
    (    createWorkflowToolExtension({ runner, agentDir: "/tmp/qronos-wf-test" }) as unknown as { factory: (api: unknown) => void }).factory(api);
    const tool = tools[0] as { execute: Function };
    await tool.execute("1", { background: false, script: `return 1;`, name: "custom" }, undefined, undefined, ctx);
    expect(getLastWorkflowRun()?.name).toBe("custom");
    await tool.execute("1", { background: false, script: `export const meta = { name: "from-meta" }\nreturn 1;` }, undefined, undefined, ctx);
    expect(getLastWorkflowRun()?.name).toBe("from-meta");
  });

  test("the last run is kept for /workflows", async () => {
    const { runner } = fakeRunner();
    const { tools, api } = fakePi();
    (    createWorkflowToolExtension({ runner, now: () => 1234, agentDir: "/tmp/qronos-wf-test" }) as unknown as { factory: (api: unknown) => void }).factory(api);
    const tool = tools[0] as { execute: Function };
    await tool.execute("1", { background: false, script: `phase("Review"); await agent("x"); return "done";` }, undefined, undefined, ctx);
    const last = getLastWorkflowRun();
    expect(last?.at).toBe(1234);
    expect(last?.result.agents).toHaveLength(1);
    expect(last?.result.phases).toEqual(["Review"]);
  });

  test("the config comes from the workflow env vars, with a ten minute clock", () => {
    expect(workflowConfigFromEnv({}).wallClockMs).toBe(600_000);
  });
});

describe("the report", () => {
  const base: WorkflowRunResult = {
    ok: true,
    value: { found: 2 },
    agents: [
      { id: "wf-1", label: "a", ok: true, durationMs: 10, depth: 1 },
      { id: "wf-2", label: "b", ok: true, durationMs: 10, depth: 1 },
    ],
    phases: ["Understand"],
    phaseStats: [{ name: "Understand", agents: 2, failed: 0, tokens: 120, durationMs: 20 }],
    logs: [],
    durationMs: 4200,
    truncated: false,
    tokens: { input: 0, output: 0, total: 0 },
  };

  test("says how many agents ran and how long it took", () => {
    const text = renderWorkflowReport("audit", base);
    expect(text).toContain("2 agents in 4s");
    expect(text).toContain("Understand");
  });

  test("singular agent is not pluralised wrongly", () => {
    const text = renderWorkflowReport("one", { ...base, agents: [base.agents[0]!] });
    expect(text).toContain("1 agent in");
  });

  test("a failed run prints the reason and no value", () => {
    const text = renderWorkflowReport("bad", { ...base, ok: false, error: "boom", value: "ignored" });
    expect(text).toContain("failed: boom");
    expect(text).not.toContain("ignored");
  });

  test("failed agents are counted", () => {
    const text = renderWorkflowReport("mixed", {
      ...base,
      agents: [...base.agents, { id: "wf-3", label: "c", ok: false, error: "no answer", durationMs: 10, depth: 1 }],
    });
    expect(text).toContain("1 failed");
  });

  test("a run whose agents returned data ends with a table", () => {
    const text = renderWorkflowReport("areas", {
      ...base,
      agents: [
        { id: "wf-1", label: "coding-agent", ok: true, durationMs: 10, depth: 1, data: { project: "coding-agent", about: "the agent loop" } },
        { id: "wf-2", label: "ai-and-tui", ok: true, durationMs: 10, depth: 1, data: { project: "ai-and-tui", about: "providers and the TUI" } },
      ],
    });
    expect(text).toContain("results:");
    expect(text).toContain("project");
    expect(text).toContain("coding-agent");
  });

  test("a run without structured data gets no table, not an empty one", () => {
    expect(renderWorkflowReport("areas", base)).not.toContain("results:");
  });

  test("a huge value is shortened with a visible marker", () => {
    const text = renderWorkflowReport("big", { ...base, value: "y".repeat(9000) });
    expect(text).toContain("more characters in the run details");
  });

  test("the log tail is shown", () => {
    const text = renderWorkflowReport("logs", { ...base, logs: ["one", "two"] });
    expect(text).toContain("--- log ---");
    expect(text).toContain("two");
  });
});

describe("the /workflows detail", () => {
  const run = {
    name: "audit",
    at: 1,
    result: {
      ok: true,
      value: 1,
      agents: [
        { id: "wf-1", label: "routes", ok: true, durationMs: 10, depth: 1 },
        { id: "wf-2", label: "middleware", ok: false, error: "no answer", durationMs: 10, depth: 1 },
      ],
      phases: ["Understand", "Review"],
      phaseStats: [
        { name: "Understand", agents: 1, failed: 0, tokens: 70, durationMs: 10 },
        { name: "Review", agents: 1, failed: 1, tokens: 50, durationMs: 10 },
      ],
      logs: ["started"],
      durationMs: 61_000,
      truncated: false,
      tokens: { input: 0, output: 0, total: 0 },
    } satisfies WorkflowRunResult,
  };

  test("says how to start one when nothing has run", () => {
    const text = renderWorkflowDetail(undefined);
    expect(text).toContain("No workflow has run");
    expect(text).toContain("ultracode");
  });

  test("lists each agent with a tick or a cross", () => {
    const text = renderWorkflowDetail(run).replace(/\x1b\[[0-9;]*m/g, "");
    expect(text).toContain("routes");
    expect(text).toContain("middleware");
    expect(text).toContain("✓");
    expect(text).toContain("✗");
    expect(text).toContain("no answer");
  });

  test("prints the phases and the time", () => {
    const text = renderWorkflowDetail(run);
    expect(text).toContain("Understand");
    expect(text).toContain("Review");
    expect(text).toContain("1m 01s");
  });

  test("counts the failures", () => {
    expect(renderWorkflowDetail(run)).toContain("1 failed");
  });

  test("shows the token split", () => {
    expect(renderWorkflowDetail(run)).toContain("in 0 / out 0");
  });
});
