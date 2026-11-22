import { describe, expect, test } from "bun:test";
import type { WorkflowJob } from "../src/workflow-jobs";
import type { WorkflowAgentRecord } from "../src/workflow-types";
import {
  agentsOfPhase,
  phaseRerunLines,
  phaseRerunNotice,
  phaseRerunRefusal,
  phaseRerunTitle,
  rerunPhase,
} from "../src/workflow-phase-rerun";

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
    done: 2,
    failed: 0,
    tokens: { input: 0, output: 0, total: 0 },
    replayed: 0,
    replayedTokens: { input: 0, output: 0, total: 0 },
    phases: ["Look", "Write"],
    phaseStats: [],
    agents: [agent({ id: "#0", label: "alpha" }), agent({ id: "#1", label: "beta" }), agent({ id: "#2", label: "gamma", phase: "Write" })],
    recent: [],
    live: new Map(),
    settled: Promise.resolve() as unknown as Promise<WorkflowJob>,
    ...overrides,
  }) as WorkflowJob;

describe("when a phase can be run again", () => {
  test("a settled run with a known phase can", () => {
    expect(phaseRerunRefusal(job(), "Look")).toBeUndefined();
  });

  test("a live run is refused, before any card appears", () => {
    for (const state of ["running", "paused", "queued"] as const) {
      expect(phaseRerunRefusal(job({ state }), "Look")).toBe("stop the run first: two agents must not spend at once");
    }
  });

  test("an unknown phase is refused with the ones that exist", () => {
    const error = phaseRerunRefusal(job(), "Audit")!;
    expect(error).toContain('no phase called "Audit"');
    expect(error).toContain("Look");
    expect(error).toContain("Write");
  });

  test("a missing phase name asks for one instead of guessing", () => {
    expect(phaseRerunRefusal(job(), "  ")).toBe("name a phase: Look, Write");
  });

  test("a run with no named phases says so", () => {
    const unnamed = job({ phases: [""], agents: [agent({ phase: undefined })] });
    expect(phaseRerunRefusal(unnamed, "Look")).toContain("this run has no named phases");
    expect(phaseRerunRefusal(unnamed, "")).toBe("this run has no named phases");
  });

  test("a phase with nothing in it is not a thing to run again", () => {
    expect(phaseRerunRefusal(job({ phases: ["Look", "Empty"] }), "Empty")).toBe(
      'the phase "Empty" has no agents to run again',
    );
  });

  test("a run that does not exist is refused", () => {
    expect(phaseRerunRefusal(undefined, "Look")).toBe("no such run");
  });
});

describe("what the card says", () => {
  test("it names the phase, the count, and the old price", () => {
    const lines = phaseRerunLines(job(), "Look");
    expect(lines[0]).toBe("phase: Look");
    expect(lines[1]).toBe("2 agents run again, one at a time");
    expect(lines[2]).toBe("they spent 240 tokens the first time");
    expect(lines[3]).toBe("this is new work: the bill goes up");
  });

  test("one agent is not one agents", () => {
    expect(phaseRerunLines(job({ agents: [agent()] }), "Look")[1]).toBe("1 agent run again, one at a time");
  });

  test("it never grows past four facts", () => {
    expect(phaseRerunLines(job(), "Look").length).toBeLessThanOrEqual(4);
  });

  test("the title is the one the notice can repeat", () => {
    expect(phaseRerunTitle("Look")).toBe('Run the phase "Look" again?');
  });
});

describe("running a phase again", () => {
  test("it runs every agent of that phase, in order", async () => {
    const asked: string[] = [];
    const outcome = await rerunPhase(job(), "Look", async (id) => {
      asked.push(id);
      return { ok: true, agent: agent({ id }) };
    });
    expect(asked).toEqual(["#0", "#1"]);
    expect(outcome).toEqual({ ok: true, phase: "Look", ran: 2, total: 2, skipped: [] });
  });

  test("one agent that cannot run does not stop the others", async () => {
    const outcome = await rerunPhase(job(), "Look", async (id) =>
      id === "#0" ? { ok: false, error: "the provider said no" } : { ok: true, agent: agent({ id }) },
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.ran).toBe(1);
      expect(outcome.total).toBe(2);
      expect(outcome.skipped).toEqual([{ label: "alpha", error: "the provider said no" }]);
    }
  });

  test("a refused phase starts nothing at all", async () => {
    let calls = 0;
    const outcome = await rerunPhase(job({ state: "running" }), "Look", async () => {
      calls += 1;
      return { ok: true, agent: agent() };
    });
    expect(calls).toBe(0);
    expect(outcome.ok).toBe(false);
  });

  test("the agents of one phase are selected by name, not by position", () => {
    expect(agentsOfPhase(job(), "Write").map((entry) => entry.id)).toEqual(["#2"]);
  });
});

describe("what the notice says", () => {
  test("a clean rerun says how many and that it cost", () => {
    expect(phaseRerunNotice({ ok: true, phase: "Look", ran: 2, total: 2, skipped: [] })).toBe(
      'ran 2 of 2 again in "Look": the tokens went up',
    );
  });

  test("a partial rerun names the first one that did not run", () => {
    const text = phaseRerunNotice({
      ok: true,
      phase: "Look",
      ran: 1,
      total: 3,
      skipped: [
        { label: "alpha", error: "the provider said no" },
        { label: "beta", error: "no such agent" },
      ],
    });
    expect(text).toContain("ran 1 of 3");
    expect(text).toContain("alpha did not run: the provider said no");
    expect(text).toContain("(+1 more)");
  });

  test("a refusal is the refusal, with nothing glued on", () => {
    expect(phaseRerunNotice({ ok: false, error: "not run again: you said no" })).toBe("not run again: you said no");
  });
});
