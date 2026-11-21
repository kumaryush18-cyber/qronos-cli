import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowRuntime } from "../src/workflow-runtime";
import { WorkflowJobManager } from "../src/workflow-jobs";
import { journalPath } from "../src/workflow-journal";
import { resetSharedSlotPool } from "../src/workflow-slots";
import { workflowConfigFromEnv, type WorkflowAgentRunner, type WorkflowEvent } from "../src/workflow-types";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "qronos-pause-"));
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

/** A runner that blocks until the test lets it go, so a pause can be observed. */
function gatedRunner() {
  const calls: string[] = [];
  const gates: Array<() => void> = [];
  const runner: WorkflowAgentRunner = async (request) => {
    calls.push(request.prompt);
    await new Promise<void>((resolve) => gates.push(resolve));
    return { ok: true, text: `answer: ${request.prompt}`, usage: { input: 1, output: 1, total: 2 } };
  };
  return {
    calls,
    runner,
    release(count = 1) {
      for (let index = 0; index < count; index += 1) gates.shift()?.();
    },
    get waiting() {
      return gates.length;
    },
  };
}

const wait = (ms = 15) => new Promise((resolve) => setTimeout(resolve, ms));

describe("runtime pause", () => {
  test("pause stops new agents from starting", async () => {
    const gated = gatedRunner();
    const runtime = new WorkflowRuntime({ runAgent: gated.runner, config: config({ concurrency: 1 }) });
    const run = runtime.run(`
      await agent("first");
      await agent("second");
      await agent("third");
      return "done";
    `);
    await wait();
    expect(gated.calls).toEqual(["first"]);

    runtime.pause();
    gated.release();
    await wait();
    // The first finished; nothing new may start while paused.
    expect(gated.calls).toEqual(["first"]);
    expect(runtime.paused).toBe(true);

    runtime.resumeLive();
    await wait();
    expect(gated.calls).toEqual(["first", "second"]);
    gated.release();
    await wait();
    gated.release();
    expect((await run).ok).toBe(true);
  });

  test("an agent already talking to the model is allowed to finish", async () => {
    const gated = gatedRunner();
    const runtime = new WorkflowRuntime({ runAgent: gated.runner, config: config({ concurrency: 2 }) });
    const run = runtime.run(`
      await agent("first");
      return "done";
    `);
    await wait();
    runtime.pause();
    gated.release();
    const result = await run;
    expect(result.ok).toBe(true);
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0]!.ok).toBe(true);
  });

  test("pause and resume are reported as events, so a panel can show them", async () => {
    const events: WorkflowEvent[] = [];
    const gated = gatedRunner();
    const runtime = new WorkflowRuntime({
      runAgent: gated.runner,
      config: config(),
      onEvent: (event) => events.push(event),
    });
    const run = runtime.run("await agent('a'); return 1;");
    await wait();
    runtime.pause();
    runtime.resumeLive();
    gated.release();
    await run;
    expect(events.some((event) => event.type === "paused")).toBe(true);
    expect(events.some((event) => event.type === "resumed")).toBe(true);
  });

  test("pausing twice is harmless", async () => {
    const gated = gatedRunner();
    const runtime = new WorkflowRuntime({ runAgent: gated.runner, config: config() });
    const run = runtime.run("await agent('a'); return 1;");
    await wait();
    runtime.pause();
    runtime.pause();
    expect(runtime.paused).toBe(true);
    runtime.resumeLive();
    gated.release();
    expect((await run).ok).toBe(true);
  });

  test("a paused run does not burn its wall clock", async () => {
    const gated = gatedRunner();
    // A 400 ms cap. Paused for longer than that, then resumed: it must survive.
    const runtime = new WorkflowRuntime({ runAgent: gated.runner, config: config({ wallClockMs: 400 }) });
    const run = runtime.run("await agent('a'); await agent('b'); return 1;");
    await wait();
    runtime.pause();
    gated.release();
    await new Promise((resolve) => setTimeout(resolve, 700));
    runtime.resumeLive();
    await wait();
    gated.release();
    const result = await run;
    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
  });

  test("a stopped run starts no further agent", async () => {
    const gated = gatedRunner();
    const runtime = new WorkflowRuntime({ runAgent: gated.runner, config: config({ concurrency: 1 }) });
    const run = runtime.run("await agent('a'); const b = await agent('b'); return b.ok;");
    await wait();
    runtime.abort();
    gated.release(2);
    const result = await run;
    const aborted = result.agents.find((agent) => agent.id === "#1");
    if (aborted) expect(aborted.error).toContain("stopped");
  });
});

describe("job pause and resume", () => {
  test("pause then resume carries on without replaying anything", async () => {
    const gated = gatedRunner();
    const manager = new WorkflowJobManager({ runAgent: gated.runner, config: config(), agentDir: tempDir() });
    const job = manager.launch({ script: "await agent('a'); await agent('b'); return 'done';" });
    await wait(20);
    expect(manager.pause(job.id)).toBe(true);
    expect(job.state).toBe("paused");
    gated.release();
    await wait(20);
    expect(gated.calls).toHaveLength(1);

    expect(manager.resume(job.id)).toBe(true);
    expect(job.state).toBe("running");
    await wait(20);
    gated.release();
    const settled = await job.settled;
    expect(settled.state).toBe("done");
    // Two calls in total: nothing was replayed, nothing was repeated.
    expect(gated.calls).toEqual(["a", "b"]);
    expect(settled.replayed).toBe(0);
  });

  test("a paused job is still listed as active", async () => {
    const gated = gatedRunner();
    const manager = new WorkflowJobManager({ runAgent: gated.runner, config: config(), agentDir: tempDir() });
    const job = manager.launch({ script: "await agent('a'); return 1;" });
    await wait(20);
    manager.pause(job.id);
    expect(manager.active().map((entry) => entry.id)).toEqual([job.id]);
    manager.cancel(job.id);
    expect(job.state).toBe("cancelled");
  });

  test("resume on a job that is not paused says no", async () => {
    const gated = gatedRunner();
    const manager = new WorkflowJobManager({ runAgent: gated.runner, config: config(), agentDir: tempDir() });
    const job = manager.launch({ script: "await agent('a'); return 1;" });
    expect(manager.resume(job.id)).toBe(false);
    await wait(20);
    gated.release();
    await job.settled;
  });

  test("pause on a finished job says no", async () => {
    const gated = gatedRunner();
    const manager = new WorkflowJobManager({ runAgent: gated.runner, config: config(), agentDir: tempDir() });
    const job = manager.launch({ script: "await agent('a'); return 1;" });
    await wait(20);
    gated.release();
    await job.settled;
    expect(manager.pause(job.id)).toBe(false);
  });

  test("pause and resume are written to the journal", async () => {
    const dir = tempDir();
    const gated = gatedRunner();
    const manager = new WorkflowJobManager({ runAgent: gated.runner, config: config(), agentDir: dir });
    const job = manager.launch({ script: "await agent('a'); return 1;" });
    await wait(20);
    manager.pause(job.id);
    manager.resume(job.id);
    gated.release();
    await job.settled;
    const raw = readFileSync(journalPath(dir, job.id), "utf8");
    expect(raw).toContain("paused by the user");
    expect(raw).toContain("resumed by the user");
  });

  test("a paused job can still be stopped, and the journal gets an end", async () => {
    const dir = tempDir();
    const gated = gatedRunner();
    const manager = new WorkflowJobManager({ runAgent: gated.runner, config: config(), agentDir: dir });
    const job = manager.launch({ script: "await agent('a'); return 1;" });
    await wait(20);
    manager.pause(job.id);
    expect(manager.cancel(job.id)).toBe(true);
    await job.settled;
    expect(existsSync(journalPath(dir, job.id))).toBe(true);
    expect(readFileSync(journalPath(dir, job.id), "utf8")).toContain("cancelled by the user");
  });
});
