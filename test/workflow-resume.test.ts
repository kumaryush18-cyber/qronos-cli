import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowJobManager } from "../src/workflow-jobs";
import { journalPath } from "../src/workflow-journal";
import { resetSharedSlotPool } from "../src/workflow-slots";
import { workflowConfigFromEnv, type WorkflowAgentRunner } from "../src/workflow-types";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "qronos-resume-"));
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

const SCRIPT = `
  const a = await agent("one");
  const b = await agent("two");
  const c = await agent("three");
  return [a.text, b.text, c.text];
`;

/** A runner with a switch, so one attempt can fail where the next succeeds. */
function switcher() {
  const calls: string[] = [];
  let failing = new Set<string>();
  const runner: WorkflowAgentRunner = async (request) => {
    calls.push(request.prompt);
    if (failing.has(request.prompt)) return { ok: false, text: "", error: "boom" };
    return { ok: true, text: `answer: ${request.prompt}`, usage: { input: 10, output: 5, total: 15 } };
  };
  return {
    calls,
    runner,
    failOnly(prompts: string[]) {
      failing = new Set(prompts);
    },
  };
}

/** Run once, wait for it, and give back the manager and the finished job. */
async function firstAttempt(dir: string) {
  const switcherInst = switcher();
  switcherInst.failOnly(["three"]);
  const manager = new WorkflowJobManager({ runAgent: switcherInst.runner, config: config(), agentDir: dir });
  const job = manager.launch({ script: SCRIPT, name: "resume-me" });
  await job.settled;
  return { manager, job, first: switcherInst };
}

describe("resumeFrom", () => {
  test("replays the finished agents and runs only the missing one", async () => {
    const dir = tempDir();
    const { manager, job } = await firstAttempt(dir);
    expect(job.result?.value).toEqual(["answer: one", "answer: two", ""]);

    const second = switcher();
    const resumed = new WorkflowJobManager({ runAgent: second.runner, config: config(), agentDir: dir });
    const replay = resumed.resumeFrom(job.id);
    await replay.settled;

    // Only the third agent reached the model the second time.
    expect(second.calls).toEqual(["three"]);
    expect(replay.replayed).toBe(2);
    expect(replay.state).toBe("done");
    // The value is identical to what the first attempt would have given.
    expect(replay.result?.value).toEqual(["answer: one", "answer: two", "answer: three"]);
    expect(manager.list()).toHaveLength(1);
  });

  test("tokens spent by a replayed agent are not spent again", async () => {
    const dir = tempDir();
    const { job } = await firstAttempt(dir);
    const second = switcher();
    const resumed = new WorkflowJobManager({ runAgent: second.runner, config: config(), agentDir: dir });
    const replay = resumed.resumeFrom(job.id);
    await replay.settled;

    // Two agents of 15 tokens were replayed, one agent of 15 was paid for.
    expect(replay.tokens.total).toBe(15);
    expect(replay.replayedTokens.total).toBe(30);
    expect(replay.result?.tokens.total).toBe(15);
    expect(replay.result?.replayed).toBe(2);
  });

  test("the replayed agents are marked in the records", async () => {
    const dir = tempDir();
    const { job } = await firstAttempt(dir);
    const resumed = new WorkflowJobManager({ runAgent: switcher().runner, config: config(), agentDir: dir });
    const replay = resumed.resumeFrom(job.id);
    await replay.settled;
    const flags = replay.agents.map((agent) => agent.replayed);
    expect(flags).toEqual([true, true, false]);
  });

  test("the resumed run writes its own journal, and says where it came from", async () => {
    const dir = tempDir();
    const { job } = await firstAttempt(dir);
    const resumed = new WorkflowJobManager({ runAgent: switcher().runner, config: config(), agentDir: dir });
    const replay = resumed.resumeFrom(job.id);
    await replay.settled;
    const raw = readFileSync(journalPath(dir, replay.id), "utf8");
    expect(raw).toContain(`"resumedFrom":"${job.id}"`);
    expect(raw).toContain('"replayed":true');
    // The original journal is untouched.
    expect(readFileSync(journalPath(dir, job.id), "utf8")).toContain('"name":"resume-me"');
  });

  test("a changed prompt runs live from that point on", async () => {
    const dir = tempDir();
    const { job } = await firstAttempt(dir);
    // Rewrite the first prompt in the saved script, the way an edited script
    // would look. Position 0 changed, so nothing may be replayed.
    const path = journalPath(dir, job.id);
    const edited = readFileSync(path, "utf8").replace('agent(\\"one\\")', 'agent(\\"ONE\\")');
    writeFileSync(path, edited);

    const second = switcher();
    const resumed = new WorkflowJobManager({ runAgent: second.runner, config: config(), agentDir: dir });
    const replay = resumed.resumeFrom(job.id);
    await replay.settled;

    expect(second.calls).toEqual(["ONE", "two", "three"]);
    expect(replay.replayed).toBe(0);
    expect(replay.result?.value).toEqual(["answer: ONE", "answer: two", "answer: three"]);
  });

  test("the saved script is what runs, not the one passed in", async () => {
    const dir = tempDir();
    const { job } = await firstAttempt(dir);
    const second = switcher();
    const resumed = new WorkflowJobManager({ runAgent: second.runner, config: config(), agentDir: dir });
    // A totally different body must be ignored: a resume continues the old run.
    const replay = resumed.launch({ script: "return 'nonsense';", resumeFrom: job.id });
    await replay.settled;
    expect(replay.result?.value).toEqual(["answer: one", "answer: two", "answer: three"]);
    expect(second.calls).toEqual(["three"]);
  });

  test("a failure is retried, not replayed", async () => {
    const dir = tempDir();
    const { job } = await firstAttempt(dir);
    const second = switcher();
    const resumed = new WorkflowJobManager({ runAgent: second.runner, config: config(), agentDir: dir });
    const replay = resumed.resumeFrom(job.id);
    await replay.settled;
    // "three" failed in the first attempt, so it is asked again.
    expect(second.calls).toContain("three");
    expect(replay.failed).toBe(0);
  });

  test("an unknown run id fails with a clear message", async () => {
    const manager = new WorkflowJobManager({ runAgent: switcher().runner, config: config(), agentDir: tempDir() });
    expect(() => manager.resumeFrom("wf_nope")).toThrow(/no saved workflow run/);
  });

  test("savedRuns lists what can be resumed", async () => {
    const dir = tempDir();
    const { manager, job } = await firstAttempt(dir);
    const runs = manager.savedRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.runId).toBe(job.id);
    expect(runs[0]!.name).toBe("resume-me");
    expect(runs[0]!.agents).toBe(3);
    expect(runs[0]!.finished).toBe(true);
  });

  test("a cancelled run can be resumed later", async () => {
    const dir = tempDir();
    const slow: WorkflowAgentRunner = async (request) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { ok: true, text: `answer: ${request.prompt}`, usage: { input: 1, output: 1, total: 2 } };
    };
    const manager = new WorkflowJobManager({ runAgent: slow, config: config(), agentDir: dir });
    const job = manager.launch({ script: SCRIPT });
    // Stop only after an agent has really finished, so there is something to
    // replay. The machine decides that timing, not the test.
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      let raw = "";
      try {
        raw = readFileSync(journalPath(dir, job.id), "utf8");
      } catch {
        raw = "";
      }
      if (raw.includes('"agent_end"')) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    manager.cancel(job.id);
    await job.settled;

    const second = switcher();
    const replay = manager.resumeFrom(job.id);
    await replay.settled;
    expect(replay.result?.value).toEqual(["answer: one", "answer: two", "answer: three"]);
    // Anything finished before the stop is reused.
    expect(replay.replayed).toBeGreaterThan(0);
    expect(second.calls.every((call) => ["one", "two", "three"].includes(call))).toBe(true);
  });

  test("a nested child replays its own answers", async () => {
    const dir = tempDir();
    const script = `
      const outer = await agent("outer");
      const inner = await workflow("const x = await agent('inner'); if (!x.ok) throw new Error('child failed'); return x.text;");
      return [outer.text, inner];
    `;
    const first = switcher();
    first.failOnly(["inner"]);
    const manager = new WorkflowJobManager({ runAgent: first.runner, config: config({ maxDepth: 2 }), agentDir: dir });
    const job = manager.launch({ script });
    await job.settled;
    // The child failed, so the parent failed too.
    expect(job.state).toBe("failed");

    const second = switcher();
    const resumedManager = new WorkflowJobManager({ runAgent: second.runner, config: config({ maxDepth: 2 }), agentDir: dir });
    const replay = resumedManager.resumeFrom(job.id);
    await replay.settled;
    // The parent's one agent came from the journal; the child's ran live.
    expect(second.calls).toEqual(["inner"]);
    expect(replay.replayed).toBeGreaterThanOrEqual(1);
  });

  test("the script sees the same time on a replay", async () => {
    const dir = tempDir();
    const stampScript = `
      const a = await agent("stamp");
      return [Date.now(), Math.random()].join(":");
    `;
    const manager = new WorkflowJobManager({ runAgent: switcher().runner, config: config(), agentDir: dir });
    const job = manager.launch({ script: stampScript });
    await job.settled;
    const resumeManager = new WorkflowJobManager({
      runAgent: switcher().runner,
      config: config(),
      agentDir: dir,
      // A different real clock, to prove the frozen one is used instead.
      now: () => 9_999_999,
    });
    const replay = resumeManager.resumeFrom(job.id);
    await replay.settled;
    const [time, random] = String(job.result?.value).split(":");
    // The script's own clock is frozen at the original start, not the new one.
    expect(String(job.result?.value).startsWith("9")).toBe(false);
    expect(time).toBe(String(job.startedAt));
    // And the seeded random repeats, so a script that shuffles shuffles the same.
    expect(String(replay.result?.value).split(":")[1]).toBe(random);
  });
});
