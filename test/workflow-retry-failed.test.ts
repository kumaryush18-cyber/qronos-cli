import { describe, expect, test } from "bun:test";
import type { WorkflowJob } from "../src/workflow-jobs";
import type { WorkflowAgentRecord } from "../src/workflow-types";
import {
  failedAgents,
  retryFailed,
  retryFailedLines,
  retryFailedNotice,
  retryFailedTitle,
  retryRefusal,
} from "../src/workflow-retry-failed";

const agent = (overrides: Partial<WorkflowAgentRecord> = {}): WorkflowAgentRecord => ({
  id: "#0",
  label: "read-the-tests",
  ok: true,
  durationMs: 1_000,
  usage: { input: 100, output: 20, total: 120 },
  depth: 1,
  phase: "Look",
  ...overrides,
});

const job = (overrides: Partial<WorkflowJob> = {}): WorkflowJob =>
  ({
    id: "wf_abc12301",
    name: "review",
    state: "done",
    script: "",
    startedAt: 0,
    running: 0,
    done: 3,
    failed: 1,
    tokens: { input: 0, output: 0, total: 0 },
    replayed: 0,
    replayedTokens: { input: 0, output: 0, total: 0 },
    phases: ["Look"],
    phaseStats: [],
    agents: [
      agent({ id: "#0", label: "alpha", ok: true }),
      agent({ id: "#1", label: "beta", ok: false, error: "no answer" }),
      agent({ id: "#2", label: "gamma", ok: true }),
    ],
    recent: [],
    live: new Map(),
    settled: Promise.resolve() as unknown as Promise<WorkflowJob>,
    ...overrides,
  }) as WorkflowJob;

describe("which agents a retry picks", () => {
  test("the failed ones, and only them", () => {
    expect(failedAgents(job()).map((entry) => entry.id)).toEqual(["#1"]);
  });

  test("a stopped agent is not a failed agent", () => {
    // You stopped it on purpose. A key that quietly starts it again would undo
    // that decision, so the stop wins.
    const withStop = job({
      agents: [
        agent({ id: "#0", ok: false, error: "no answer" }),
        agent({ id: "#1", ok: false, error: "stopped by you", stopped: true }),
      ],
    });
    expect(failedAgents(withStop).map((entry) => entry.id)).toEqual(["#0"]);
  });

  test("a replayed answer that failed is retried: the journal may be stale", () => {
    const replayed = job({ agents: [agent({ id: "#0", ok: false, error: "schema mismatch", replayed: true })] });
    expect(failedAgents(replayed).length).toBe(1);
  });
});

describe("when a retry can happen", () => {
  test("a settled run with a failure can", () => {
    expect(retryRefusal(job())).toBeUndefined();
  });

  test("a live run is refused, before any card appears", () => {
    for (const state of ["running", "paused", "queued"] as const) {
      expect(retryRefusal(job({ state }))).toBe("stop the run first: two agents must not spend at once");
    }
  });

  test("a run with no failures says so", () => {
    const clean = job({ agents: [agent({ ok: true })] });
    expect(retryRefusal(clean)).toBe("nothing failed in this run");
  });

  test("a run where everything that failed was stopped says why, not just no", () => {
    // This is the case where a bare "nothing failed" would be a lie: something
    // did not finish, and the reason is you.
    const stoppedOnly = job({ agents: [agent({ id: "#0", ok: false, error: "stopped by you", stopped: true })] });
    expect(retryRefusal(stoppedOnly)).toBe(
      "nothing failed in this run: the one that is marked stopped was stopped by you",
    );
    const two = job({
      agents: [
        agent({ id: "#0", ok: false, error: "stopped by you", stopped: true }),
        agent({ id: "#1", ok: false, error: "stopped by you", stopped: true }),
      ],
    });
    expect(retryRefusal(two)).toBe("nothing failed in this run: the 2 that are marked stopped were stopped by you");
  });

  test("a run that does not exist is refused", () => {
    expect(retryRefusal(undefined)).toBe("no such run");
  });
});

describe("what the retry card says", () => {
  test("it names the count, the labels, and the old price", () => {
    const lines = retryFailedLines(job());
    expect(lines[0]).toBe("1 failed agent run again, one at a time");
    expect(lines[1]).toBe("beta");
    expect(lines[2]).toBe("they spent 120 tokens the first time");
    expect(lines[3]).toBe("this is new work: the bill goes up");
  });

  test("many agents are counted, and the labels are cut with a count", () => {
    const many = job({
      agents: [
        agent({ id: "#0", label: "a", ok: false }),
        agent({ id: "#1", label: "b", ok: false }),
        agent({ id: "#2", label: "c", ok: false }),
      ],
    });
    const lines = retryFailedLines(many);
    expect(lines[0]).toBe("3 failed agents run again, one at a time");
    expect(lines[1]).toBe("a, b +1");
  });

  test("the title counts the same agents the card lists", () => {
    expect(retryFailedTitle(job())).toBe("Run the failed agent again?");
    const two = job({
      agents: [
        agent({ id: "#0", ok: false }),
        agent({ id: "#1", ok: false }),
      ],
    });
    expect(retryFailedTitle(two)).toBe("Run the 2 failed agents again?");
  });
});

describe("running the failed agents again", () => {
  test("it runs each failed agent once, in order", async () => {
    const asked: string[] = [];
    const outcome = await retryFailed(job(), async (id) => {
      asked.push(id);
      return { ok: true, agent: agent({ id }) };
    });
    expect(asked).toEqual(["#1"]);
    expect(outcome).toEqual({ ok: true, ran: 1, total: 1, skipped: [] });
  });

  test("it never starts the ones that worked", async () => {
    const asked: string[] = [];
    await retryFailed(job(), async (id) => {
      asked.push(id);
      return { ok: true, agent: agent({ id }) };
    });
    expect(asked).not.toContain("#0");
    expect(asked).not.toContain("#2");
  });

  test("one that cannot run does not stop the others", async () => {
    const two = job({
      agents: [
        agent({ id: "#0", label: "a", ok: false }),
        agent({ id: "#1", label: "b", ok: false }),
      ],
    });
    const outcome = await retryFailed(two, async (id) =>
      id === "#0" ? { ok: false, error: "the provider said no" } : { ok: true, agent: agent({ id }) },
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.ran).toBe(1);
      expect(outcome.total).toBe(2);
      expect(outcome.skipped).toEqual([{ label: "a", error: "the provider said no" }]);
    }
  });

  test("a refused retry starts nothing at all", async () => {
    let calls = 0;
    const outcome = await retryFailed(job({ state: "running" }), async () => {
      calls += 1;
      return { ok: true, agent: agent() };
    });
    expect(calls).toBe(0);
    expect(outcome.ok).toBe(false);
  });
});

describe("what the notice says", () => {
  test("a clean retry says how many and that it cost", () => {
    expect(retryFailedNotice({ ok: true, ran: 1, total: 1, skipped: [] })).toBe(
      "ran 1 of 1 failed again: the tokens went up",
    );
  });

  test("a partial retry names the first one that did not run", () => {
    const text = retryFailedNotice({
      ok: true,
      ran: 1,
      total: 3,
      skipped: [
        { label: "a", error: "the provider said no" },
        { label: "b", error: "no such agent" },
      ],
    });
    expect(text).toContain("ran 1 of 3");
    expect(text).toContain("a did not run: the provider said no");
    expect(text).toContain("(+1 more)");
  });

  test("a refusal is the refusal, alone", () => {
    expect(retryFailedNotice({ ok: false, error: "nothing failed in this run" })).toBe("nothing failed in this run");
  });
});
