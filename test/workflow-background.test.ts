import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createWorkflowToolExtension,
  getLastWorkflowRun,
  jobLine,
  renderJobDetail,
  renderJobList,
  resetWorkflowJobs,
} from "../src/workflow-tool";
import type { WorkflowJob } from "../src/workflow-jobs";
import { resetSharedSlotPool } from "../src/workflow-slots";
import type { SubagentRunner } from "../src/agent-tool";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "qronos-wf-bg-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  resetWorkflowJobs();
  resetSharedSlotPool();
});

function fakeRunner() {
  const prompts: string[] = [];
  const runner: SubagentRunner = async (params) => {
    prompts.push(params.prompt);
    return {
      output: `report for: ${params.prompt}`,
      turns: 1,
      toolsUsed: [],
      usage: { input: 40, output: 10, cacheRead: 0, cacheWrite: 0, total: 50 },
    };
  };
  return { prompts, runner };
}

function fakePi() {
  const tools: Array<Record<string, any>> = [];
  const messages: Array<{ message: Record<string, any>; options?: Record<string, any> }> = [];
  const notices: Array<{ text: string; level?: string }> = [];
  const statuses: Array<{ key: string; text?: string }> = [];
  const commands: Record<string, (args: string, ctx: unknown) => Promise<void>> = {};
  const api = {
    registerTool: (tool: Record<string, any>) => tools.push(tool),
    registerCommand: (name: string, spec: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
      commands[name] = spec.handler;
    },
    registerShortcut: () => {},
    on: () => {},
    sendMessage: (message: Record<string, any>, options?: Record<string, any>) => messages.push({ message, options }),
  };
  const ctx = {
    cwd: "/repo",
    ui: {
      setStatus: (key: string, text?: string) => statuses.push({ key, text }),
      notify: (text: string, level?: string) => notices.push({ text, level }),
    },
  };
  return { tools, commands, messages, notices, statuses, api, ctx };
}

function harness(options: Parameters<typeof createWorkflowToolExtension>[0] = {}) {
  const pi = fakePi();
  const extension = createWorkflowToolExtension({ agentDir: tempDir(), ...options });
  (extension as unknown as { factory: (api: unknown) => void }).factory(pi.api);
  const tool = pi.tools[0] as { execute: Function };
  return { ...pi, tool };
}

describe("background launch", () => {
  test("the tool returns at once with a job id", async () => {
    const { runner } = fakeRunner();
    const { tool, ctx } = harness({ runner });
    const result = await tool.execute("1", { script: "await agent('a'); return 1;" }, undefined, undefined, ctx);
    expect(result.details.background).toBe(true);
    expect(result.details.job).toMatch(/^wf_/);
    expect(result.content[0].text).toContain("launched as");
    expect(result.content[0].text).toContain("/workflows");
  });

  test("the report is delivered as a message on a later turn", async () => {
    const { runner } = fakeRunner();
    const { tool, ctx, messages } = harness({ runner });
    await tool.execute("1", { script: "await agent('a'); return 'done';", name: "audit" }, undefined, undefined, ctx);
    // Give the job its turn to run.
    for (let index = 0; index < 60 && messages.length === 0; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(messages).toHaveLength(1);
    expect(messages[0]!.message.customType).toBe("qronos-workflow-report");
    expect(messages[0]!.options?.deliverAs).toBe("nextTurn");
    expect(String(messages[0]!.message.content)).toContain("audit");
    expect(getLastWorkflowRun()?.name).toBe("audit");
  });

  test("a notification says it finished", async () => {
    const { runner } = fakeRunner();
    const { tool, ctx, notices } = harness({ runner });
    await tool.execute("1", { script: "await agent('a'); return 1;", name: "notify-me" }, undefined, undefined, ctx);
    for (let index = 0; index < 60 && notices.length === 0; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(notices.at(-1)?.text).toContain("notify-me");
  });

  test("nothing is delivered twice", async () => {
    const { runner } = fakeRunner();
    const { tool, ctx, messages } = harness({ runner });
    await tool.execute("1", { script: "return 1;" }, undefined, undefined, ctx);
    for (let index = 0; index < 60 && messages.length === 0; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(messages).toHaveLength(1);
  });

  test("a live status line appears and is cleared", async () => {
    const { runner } = fakeRunner();
    const { tool, ctx, statuses } = harness({ runner });
    await tool.execute("1", { script: "await agent('a'); return 1;" }, undefined, undefined, ctx);
    for (let index = 0; index < 60; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (statuses.length > 1) break;
    }
    expect(statuses.length).toBeGreaterThan(0);
    expect(statuses[0]!.key).toBe("qronos-workflow");
  });

  test("background false waits and returns the report in this turn", async () => {
    const { runner, prompts } = fakeRunner();
    const { tool, ctx } = harness({ runner });
    const result = await tool.execute(
      "1",
      { script: "const r = await agent('a'); return r.text;", background: false },
      undefined,
      undefined,
      ctx,
    );
    expect(result.details.background).toBe(false);
    expect(result.details.ok).toBe(true);
    expect(result.content[0].text).toContain("report for: a");
    expect(prompts).toEqual(["a"]);
    expect(result.details.tokens.total).toBe(50);
  });

  test("tokens from the runner reach the details", async () => {
    const { runner } = fakeRunner();
    const { tool, ctx } = harness({ runner });
    const result = await tool.execute("1", { script: "await agent('a'); return 1;", background: false }, undefined, undefined, ctx);
    expect(result.details.tokens).toEqual({ input: 40, output: 10, total: 50 });
  });
});

describe("the job list", () => {
  const base: WorkflowJob = {
    id: "wf_abc12301",
    name: "audit-routes",
    state: "running",
    script: "return 1;",
    startedAt: 1_000,
    running: 2,
    done: 5,
    failed: 0,
    tokens: { input: 900, output: 100, total: 1_000 },
    phases: ["Review"],
    phaseStats: [],
    agents: [],
    recent: [],
    settled: Promise.resolve() as never,
  };

  test("a running job shows running and done", () => {
    const line = jobLine(base);
    expect(line).toContain("wf_abc12301");
    expect(line).toContain("audit-routes");
    expect(line).toContain("2 running");
    expect(line).toContain("5 done");
    expect(line).toContain("1k tokens");
  });

  test("a finished job shows the agent count", () => {
    const line = jobLine({ ...base, state: "done", finishedAt: 5_000 });
    expect(line).toContain("5 agents");
    expect(line).not.toContain("running");
  });

  test("a failed job shows its reason", () => {
    const line = jobLine({ ...base, state: "failed", finishedAt: 5_000, error: "wall clock" });
    expect(line).toContain("wall clock");
  });

  test("the list header counts the whole pool", () => {
    const text = renderJobList([base, { ...base, id: "wf_abc12302" }], [base]);
    expect(text).toContain("2 workflows running");
    expect(text).toContain("4 agents");
    expect(text).toContain("10 done");
    expect(text).toContain("/workflows stop <id>");
  });

  test("an empty list explains how to start one", () => {
    const text = renderJobList([], []);
    expect(text).toContain("no workflow is running");
    expect(text).toContain("ultracode");
  });

  test("the detail view includes the state while running", () => {
    const text = renderJobDetail(base);
    expect(text).toContain("status: running");
  });

  test("the detail view includes the journal path when there is one", () => {
    const text = renderJobDetail({ ...base, journalPath: "/tmp/runs/wf_1.jsonl" });
    expect(text).toContain("/tmp/runs/wf_1.jsonl");
  });
});

describe("per-session isolation", () => {
  test("one session's /workflows does not list another session's job", async () => {
    const { runner } = fakeRunner();
    const first = harness({ runner });
    const second = harness({ runner });

    const launch = await first.tool.execute("1", { script: "await agent('a'); return 1;" }, undefined, undefined, first.ctx);
    const jobId = String(launch.details.job);

    const seenByFirst: string[] = [];
    const seenBySecond: string[] = [];
    await first.commands.workflows!("", { ui: { notify: (text: string) => seenByFirst.push(text) } });
    await second.commands.workflows!("", { ui: { notify: (text: string) => seenBySecond.push(text) } });

    expect(seenByFirst.join(" ")).toContain(jobId);
    expect(seenBySecond.join(" ")).not.toContain(jobId);
  });

  test("the second session cannot stop the first session's job", async () => {
    const { runner } = fakeRunner();
    const first = harness({ runner });
    const second = harness({ runner });
    const launch = await first.tool.execute("1", { script: "await agent('a'); return 1;" }, undefined, undefined, first.ctx);
    const jobId = String(launch.details.job);

    const seen: string[] = [];
    await second.commands.workflows!(`stop ${jobId}`, { ui: { notify: (text: string) => seen.push(text) } });
    expect(seen.join(" ")).toContain("No workflow with id");
  });
});
