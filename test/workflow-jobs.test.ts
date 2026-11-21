import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowJobManager } from "../src/workflow-jobs";
import { journalDir } from "../src/workflow-journal";
import { resetSharedSlotPool } from "../src/workflow-slots";
import { workflowConfigFromEnv, type WorkflowAgentRunner } from "../src/workflow-types";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "qronos-jobs-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  resetSharedSlotPool();
});

const config = (overrides: Partial<ReturnType<typeof workflowConfigFromEnv>> = {}) => ({
  ...workflowConfigFromEnv({}),
  ...overrides,
});

function fakeRunner(answer?: (prompt: string) => Promise<unknown>) {
  const calls: string[] = [];
  const runner: WorkflowAgentRunner = async (request) => {
    calls.push(request.prompt);
    if (answer) {
      const value = await answer(request.prompt);
      if (typeof value === "object" && value !== null && "ok" in (value as Record<string, unknown>)) return value as never;
      return { ok: true, text: String(value) };
    }
    return { ok: true, text: `answer: ${request.prompt}`, usage: { input: 10, output: 5, total: 15 } };
  };
  return { calls, runner };
}

describe("launch", () => {
  test("returns a job before any agent has run", async () => {
    const { calls, runner } = fakeRunner();
    const manager = new WorkflowJobManager({ runAgent: runner, config: config(), agentDir: tempDir() });
    const job = manager.launch({ script: "await agent('x'); return 1;" });
    expect(job.id.startsWith("wf_")).toBe(true);
    expect(job.state === "queued" || job.state === "running").toBe(true);
    expect(calls).toHaveLength(0);
    await job.settled;
    expect(calls).toHaveLength(1);
  });

  test("settles once, with the result and the token total", async () => {
    const { runner } = fakeRunner();
    const manager = new WorkflowJobManager({ runAgent: runner, config: config(), agentDir: tempDir() });
    const job = manager.launch({ script: "const r = await agent('a'); return r.text;" });
    const settled = await job.settled;
    expect(settled.state).toBe("done");
    expect(settled.result?.value).toBe("answer: a");
    expect(settled.tokens.total).toBe(15);
    expect(settled.done).toBe(1);
    expect(settled.finishedAt).toBeGreaterThanOrEqual(settled.startedAt);
  });

  test("a failing script becomes a failed job, not a crash", async () => {
    const { runner } = fakeRunner();
    const manager = new WorkflowJobManager({ runAgent: runner, config: config(), agentDir: tempDir() });
    const job = manager.launch({ script: "throw new Error('bad script');" });
    await job.settled;
    expect(job.state).toBe("failed");
    expect(job.error).toContain("bad script");
  });

  test("ids are unique", () => {
    const { runner } = fakeRunner();
    const manager = new WorkflowJobManager({ runAgent: runner, config: config(), agentDir: tempDir(), now: () => 1000 });
    const ids = new Set([manager.launch({ script: "return 1;" }).id, manager.launch({ script: "return 2;" }).id]);
    expect(ids.size).toBe(2);
  });
});

describe("live counters", () => {
  test("running, done, counts and tokens move while it works", async () => {
    let release: (() => void) | undefined;
    const runner: WorkflowAgentRunner = async () => {
      await new Promise<void>((resolve) => (release = resolve));
      return { ok: true, text: "x", usage: { input: 4, output: 1, total: 5 } };
    };
    const manager = new WorkflowJobManager({ runAgent: runner, config: config(), agentDir: tempDir() });
    const job = manager.launch({ script: "await agent('a'); return 1;" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(job.running).toBe(1);
    expect(job.done).toBe(0);
    release?.();
    await job.settled;
    expect(job.running).toBe(0);
    expect(job.done).toBe(1);
    expect(job.tokens.total).toBe(5);
  });

  test("phases are recorded as they are named", async () => {
    const { runner } = fakeRunner();
    const manager = new WorkflowJobManager({ runAgent: runner, config: config(), agentDir: tempDir() });
    const job = manager.launch({ script: "phase('Understand'); await agent('a'); phase('Review'); await agent('b'); return 1;" });
    await job.settled;
    expect(job.phases).toEqual(["Understand", "Review"]);
    expect(job.agents.map((agent) => agent.phase)).toEqual(["Understand", "Review"]);
  });

  test("a failed agent is counted separately", async () => {
    const { runner } = fakeRunner(async () => ({ ok: false, text: "", error: "no answer" }));
    const manager = new WorkflowJobManager({ runAgent: runner, config: config(), agentDir: tempDir() });
    const job = manager.launch({ script: "await agent('a'); return 1;" });
    await job.settled;
    expect(job.state).toBe("done");
    expect(job.failed).toBe(1);
  });
});

describe("journal", () => {
  test("a journal file is written next to the agent dir", async () => {
    const { runner } = fakeRunner();
    const agentDir = tempDir();
    const manager = new WorkflowJobManager({ runAgent: runner, config: config(), agentDir });
    const job = manager.launch({ script: "phase('A'); await agent('x'); return 1;" });
    await job.settled;
    const path = join(journalDir(agentDir), `${job.id}.jsonl`);
    expect(existsSync(path)).toBe(true);
    const lines = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(lines[0].kind).toBe("run_start");
    expect(lines.at(-1).kind).toBe("run_end");
    expect(lines.some((entry: { kind: string }) => entry.kind === "agent_end")).toBe(true);
  });

  test("the journal keeps the script, so a run could be replayed", async () => {
    const { runner } = fakeRunner();
    const agentDir = tempDir();
    const manager = new WorkflowJobManager({ runAgent: runner, config: config(), agentDir });
    const job = manager.launch({ script: "return 41 + 1;", name: "tiny" });
    await job.settled;
    const first = JSON.parse(readFileSync(join(journalDir(agentDir), `${job.id}.jsonl`), "utf8").split("\n")[0]!);
    expect(first.script).toBe("return 41 + 1;");
    expect(first.name).toBe("tiny");
  });

  test("a cancelled job still closes its journal", async () => {
    const runner: WorkflowAgentRunner = async () => new Promise(() => {});
    const agentDir = tempDir();
    const manager = new WorkflowJobManager({ runAgent: runner, config: config(), agentDir });
    const job = manager.launch({ script: "await agent('slow'); return 1;" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(manager.cancel(job.id)).toBe(true);
    const raw = readFileSync(join(journalDir(agentDir), `${job.id}.jsonl`), "utf8");
    expect(raw).toContain("cancelled");
  });
});

describe("cancel", () => {
  test("cancel stops a running job and marks it cancelled", async () => {
    const runner: WorkflowAgentRunner = async () => new Promise(() => {});
    const manager = new WorkflowJobManager({ runAgent: runner, config: config(), agentDir: tempDir() });
    const job = manager.launch({ script: "await agent('never'); return 1;" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(manager.cancel(job.id)).toBe(true);
    await job.settled;
    expect(job.state).toBe("cancelled");
    expect(manager.active()).toHaveLength(0);
  });

  test("cancelling twice is false, not a crash", async () => {
    const { runner } = fakeRunner();
    const manager = new WorkflowJobManager({ runAgent: runner, config: config(), agentDir: tempDir(), startImmediately: true });
    const job = manager.launch({ script: "return 1;" });
    await job.settled;
    expect(manager.cancel(job.id)).toBe(false);
  });

  test("an unknown id is false", () => {
    const manager = new WorkflowJobManager({ runAgent: fakeRunner().runner, config: config(), agentDir: tempDir() });
    expect(manager.cancel("nope")).toBe(false);
  });
});

describe("lists and pruning", () => {
  test("active() only lists work that is still going", async () => {
    const { runner } = fakeRunner();
    const manager = new WorkflowJobManager({ runAgent: runner, config: config({ concurrency: 1 }), agentDir: tempDir() });
    const first = manager.launch({ script: "await agent('a'); return 1;" });
    const second = manager.launch({ script: "await agent('b'); return 2;" });
    await Promise.all([first.settled, second.settled]);
    expect(manager.active()).toHaveLength(0);
    expect(manager.list()).toHaveLength(2);
  });

  test("prune forgets old settled jobs but keeps the newest", async () => {
    const { runner } = fakeRunner();
    const manager = new WorkflowJobManager({ runAgent: runner, config: config(), agentDir: tempDir() });
    for (let index = 0; index < 4; index += 1) {
      const job = manager.launch({ script: "return 1;" });
      await job.settled;
    }
    expect(manager.list()).toHaveLength(4);
    expect(manager.prune(2)).toBe(2);
    expect(manager.list()).toHaveLength(2);
  });

  test("onSettle runs exactly once per job", async () => {
    const settled: string[] = [];
    const { runner } = fakeRunner();
    const manager = new WorkflowJobManager({
      runAgent: runner,
      config: config(),
      agentDir: tempDir(),
      onSettle: (job) => settled.push(job.id),
    });
    const job = manager.launch({ script: "return 1;" });
    await job.settled;
    manager.cancel(job.id);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toEqual([job.id]);
  });
});
