import { describe, expect, test } from "bun:test";
import {
  buildPanelLines,
  moveIndex,
  panelBar,
  panelSummary,
  toPanelJob,
  wrap,
  type PanelJobView,
  type PanelState,
} from "../src/workflow-panel-view";
import type { WorkflowJob } from "../src/workflow-jobs";
import type { WorkflowEvent } from "../src/workflow-types";

const job = (overrides: Partial<WorkflowJob> = {}): WorkflowJob => ({
  id: "wf_abc12301",
  name: "auth-audit",
  state: "running",
  script: "// audit\nexport const meta = { name: 'x' }\nphase('Review')\nconst out = await agent('list files')\nreturn out.text",
  startedAt: 1_000,
  running: 1,
  done: 2,
  failed: 0,
  tokens: { input: 900, output: 100, total: 1_000 },
  replayed: 1,
  replayedTokens: { input: 100, output: 50, total: 150 },
  phases: ["Understand", "Review"],
  phaseStats: [
    { name: "Understand", agents: 1, failed: 0, tokens: 300, durationMs: 100 },
    { name: "Review", agents: 2, failed: 1, tokens: 700, durationMs: 200 },
  ],
  agents: [
    { id: "#0", label: "routes.ts", ok: true, durationMs: 19_000, usage: { input: 1, output: 1, total: 7100 }, depth: 1, phase: "Review" },
    { id: "#1", label: "middleware.ts", ok: true, durationMs: 0, usage: { input: 1, output: 1, total: 5000 }, depth: 1, replayed: true },
    { id: "#2", label: "db.ts", ok: false, error: "no answer", durationMs: 4_000, depth: 1 },
  ],
  recent: [] as WorkflowEvent[],
  settled: Promise.resolve() as unknown as Promise<WorkflowJob>,
  ...overrides,
});

const state = (overrides: Partial<PanelState> = {}): PanelState => {
  const view = toPanelJob(job(), 61_000);
  return {
    jobs: [view],
    job: view,
    selectedAgent: 0,
    mode: "list",
    width: 74,
    now: 61_000,
    height: 26,
    ...overrides,
  };
};

const text = (lines: { text: string }[]) => lines.map((line) => line.text).join("\n");

describe("toPanelJob", () => {
  test("carries the numbers the panel shows", () => {
    const view = toPanelJob(job(), 61_000);
    expect(view.id).toBe("wf_abc12301");
    expect(view.done).toBe(2);
    expect(view.tokens).toBe(1_000);
    expect(view.replayed).toBe(1);
    expect(view.elapsedMs).toBe(60_000);
  });

  test("marks a replayed agent", () => {
    const view = toPanelJob(job(), 61_000);
    expect(view.agents[1]!.replayed).toBe(true);
  });

  test("marks the phase that is still working", () => {
    const view = toPanelJob(job(), 61_000);
    const review = view.phases.find((phase) => phase.name === "Review");
    expect(review?.active).toBe(true);
    expect(view.phases[0]!.active).toBe(false);
  });

  test("a finished job has no active phase", () => {
    const view = toPanelJob(job({ state: "done", finishedAt: 61_000 }), 61_000);
    expect(view.phases.every((phase) => !phase.active)).toBe(true);
  });

  test("takes the first real script line, skipping meta and comments", () => {
    expect(toPanelJob(job(), 1).scriptHint).toContain("phase('Review')");
  });

  test("shows an answer when a recent event still has one", () => {
    const withAnswer = job({
      recent: [
        { type: "agent_start", at: 1, id: "#0", label: "routes.ts", depth: 1 },
        { type: "agent_end", at: 2, id: "#0", label: "routes.ts", ok: true, durationMs: 1, depth: 1, text: "found 3 routes" },
      ],
    });
    expect(toPanelJob(withAnswer, 1).agents[0]!.answer).toBe("found 3 routes");
  });

  test("a stopped job keeps its error", () => {
    const view = toPanelJob(job({ state: "cancelled", error: "cancelled by the user" }), 61_000);
    expect(view.error).toBe("cancelled by the user");
  });
});

describe("panelBar", () => {
  test("an empty value draws nothing", () => {
    expect(panelBar(0, 100, 8)).toBe(" ".repeat(8));
  });

  test("the biggest value fills the bar", () => {
    expect(panelBar(100, 100, 8)).toBe("█".repeat(8));
  });

  test("a small value still shows one cell, so it is not invisible", () => {
    expect(panelBar(1, 100_000, 8)).toBe(`${"█"}${" ".repeat(7)}`);
  });

  test("the width is always exact", () => {
    for (const value of [0, 1, 50, 99, 100]) expect(panelBar(value, 100, 10)).toHaveLength(10);
  });

  test("a zero maximum does not divide by zero", () => {
    expect(panelBar(5, 0, 4)).toBe("█".repeat(4));
  });
});

describe("buildPanelLines", () => {
  test("the header names the job, the counts, the tokens and the time", () => {
    const lines = text(buildPanelLines(state()));
    expect(lines).toContain("auth-audit");
    expect(lines).toContain("1 running · 2 done");
    expect(lines).toContain("1k tokens");
    expect(lines).toContain("1m 00s");
  });

  test("a failure is counted in the header", () => {
    const view = toPanelJob(job({ failed: 1 }), 61_000);
    const lines = text(buildPanelLines(state({ job: view })));
    expect(lines).toContain("1 failed");
  });

  test("phases are drawn with their token bars", () => {
    const lines = text(buildPanelLines(state()));
    expect(lines).toContain("▸ Understand");
    expect(lines).toContain("▸ Review");
    expect(lines).toMatch(/▸ Review.*█/);
  });

  test("a phase with a failure is marked with a cross", () => {
    const lines = text(buildPanelLines(state()));
    expect(lines).toContain("✗ 1");
  });

  test("agent rows carry a tick, a replay glyph and a cross", () => {
    const lines = text(buildPanelLines(state()));
    expect(lines).toContain("✓ routes.ts");
    expect(lines).toContain("↺ middleware.ts");
    expect(lines).toContain("✗ db.ts");
  });

  test("a replayed agent says so instead of pretending it took time", () => {
    const lines = text(buildPanelLines(state()));
    expect(lines).toMatch(/↺ middleware\.ts.*replayed/);
  });

  test("a failed agent explains itself under its row", () => {
    const lines = text(buildPanelLines(state()));
    expect(lines).toContain("no answer");
  });

  test("the footer offers pause while running, resume while paused", () => {
    expect(text(buildPanelLines(state()))).toContain("space pause");
    const paused = toPanelJob(job({ state: "paused" }), 61_000);
    expect(text(buildPanelLines(state({ job: paused })))).toContain("space resume");
  });

  test("the footer offers a retry when nothing is live", () => {
    const done = toPanelJob(job({ state: "done", finishedAt: 61_000 }), 61_000);
    expect(text(buildPanelLines(state({ job: done })))).toContain("space retry");
  });

  test("a resumed run says where it came from", () => {
    const resumed = toPanelJob(job({ resumedFrom: "wf_old01" }), 61_000);
    const lines = text(buildPanelLines(state({ job: resumed })));
    expect(lines).toContain("resumed from old01");
  });

  test("an empty state explains how to start, without pretending it has data", () => {
    const lines = text(buildPanelLines(state({ job: undefined })));
    expect(lines).toContain("Nothing has run in this session yet.");
    expect(lines).toContain("ultracode");
    expect(lines).not.toContain("running");
  });

  test("every line fits the panel width", () => {
    for (const width of [40, 74, 120]) {
      for (const line of buildPanelLines(state({ width }))) {
        expect(line.text.length).toBeLessThanOrEqual(width - 2);
      }
    }
  });

  test("a very long name is cut, not wrapped, so the box stays square", () => {
    const wide = toPanelJob(job({ name: "x".repeat(200) }), 61_000);
    for (const line of buildPanelLines(state({ job: wide }))) {
      expect(line.text).toHaveLength(line.text.length);
      expect(line.text.length).toBeLessThanOrEqual(72);
    }
  });

  test("the running job is marked active so the panel can add the shimmer", () => {
    const styles = buildPanelLines(state()).filter((line) => line.style === "phase-active");
    expect(styles).toHaveLength(1);
  });

  test("agents are ordered running first, then failures, then cost", () => {
    const view = toPanelJob(
      job({
        agents: [
          { id: "#0", label: "cheap", ok: true, durationMs: 1, usage: { input: 1, output: 1, total: 10 }, depth: 1 },
          { id: "#1", label: "expensive", ok: true, durationMs: 1, usage: { input: 1, output: 1, total: 900 }, depth: 1 },
          { id: "#2", label: "broken", ok: false, durationMs: 1, depth: 1 },
        ],
      }),
      61_000,
    );
    const lines = buildPanelLines(state({ job: view })).map((line) => line.text);
    const order = ["broken", "expensive", "cheap"].map((label) => lines.findIndex((line) => line.includes(label)));
    expect(order[0]).toBeLessThan(order[1]);
    expect(order[1]).toBeLessThan(order[2]);
  });
});

describe("the agent view", () => {
  test("shows the facts of one agent", () => {
    // The list and the detail view sort the same way, so index 1 is routes.ts
    // (failures first, then the expensive ones).
    const view = toPanelJob(job(), 61_000);
    const lines = text(buildPanelLines(state({ job: view, mode: "agent", selectedAgent: 1 })));
    expect(lines).toContain("routes.ts");
    expect(lines).toContain("7.1k tokens");
    expect(lines).toContain("19s");
    expect(lines).toContain("top level");
  });

  test("a replayed agent says it came from the journal", () => {
    const view = toPanelJob(job(), 61_000);
    const lines = text(buildPanelLines(state({ job: view, mode: "agent", selectedAgent: 2 })));
    expect(lines).toContain("replayed from the journal");
  });

  test("an error and an answer are wrapped, not cut", () => {
    const view = toPanelJob(
      job({
        recent: [
          { type: "agent_end", at: 2, id: "#2", label: "db.ts", ok: false, error: "boom", durationMs: 1, depth: 1, text: "line one line two" },
        ],
      }),
      61_000,
    );
    const lines = text(buildPanelLines(state({ job: view, mode: "agent", selectedAgent: 0 })));
    expect(lines).toContain("error");
    expect(lines).toContain("answer");
  });

  test("the escape hint goes back to the list", () => {
    const view = toPanelJob(job(), 61_000);
    expect(text(buildPanelLines(state({ job: view, mode: "agent" })))).toContain("esc back");
  });
});

describe("helpers", () => {
  test("moveIndex stays inside the list", () => {
    expect(moveIndex(0, 3, -1)).toBe(0);
    expect(moveIndex(2, 3, 1)).toBe(2);
    expect(moveIndex(1, 3, 1)).toBe(2);
    expect(moveIndex(0, 0, 1)).toBe(0);
  });

  test("wrap keeps every word", () => {
    expect(wrap("one two three", 40).join(" ")).toBe("one two three");
    expect(wrap("", 40)).toHaveLength(0);
    const long = wrap("a".repeat(30), 10);
    expect(long.length).toBeGreaterThan(1);
  });

  test("panelSummary is one line for the status bar", () => {
    const running = toPanelJob(job(), 61_000);
    expect(panelSummary(running)).toContain("1 running");
    const done = toPanelJob(job({ state: "done" }), 61_000);
    expect(panelSummary(done)).toContain("✓");
    const paused = toPanelJob(job({ state: "paused" }), 61_000);
    expect(panelSummary(paused)).toContain("paused");
    expect(panelSummary(undefined)).toBe("");
  });
});

describe("agents that are still working", () => {
  const liveJob = () =>
    job({
      done: 0,
      running: 3,
      agents: [],
      phaseStats: [],
      recent: [
        { type: "agent_start", at: 1, id: "#0", label: "src/a.ts", depth: 1 },
        { type: "agent_start", at: 2, id: "#1", label: "src/b.ts", depth: 1 },
        { type: "agent_start", at: 3, id: "#2", label: "src/c.ts", depth: 1 },
      ] as never,
    });

  test("they get a row each, with their own name", () => {
    const view = toPanelJob(liveJob(), 61_000);
    expect(view.agents).toHaveLength(3);
    expect(view.agents.map((agent) => agent.label)).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
    expect(view.agents.every((agent) => agent.running)).toBe(true);
  });

  test("the panel marks them with the running glyph", () => {
    const view = toPanelJob(liveJob(), 61_000);
    const lines = text(buildPanelLines(state({ job: view })));
    expect(lines).toContain("✻ src/a.ts");
    expect(lines).toContain("✻ src/c.ts");
  });

  test("an agent that already ended is not drawn twice", () => {
    const both = liveJob();
    both.recent = [
      ...both.recent,
      { type: "agent_end", at: 4, id: "#0", label: "src/a.ts", ok: true, durationMs: 3, depth: 1 } as never,
    ];
    both.running = 2;
    both.done = 1;
    both.agents = [{ id: "#0", label: "src/a.ts", ok: true, durationMs: 3, depth: 1 }];
    const view = toPanelJob(both, 61_000);
    expect(view.agents.filter((agent) => agent.label === "src/a.ts")).toHaveLength(1);
  });

  test("a finished run has no running rows", () => {
    const view = toPanelJob(liveJob(), 61_000);
    const finished = { ...view, state: "done", agents: view.agents.filter((agent) => !agent.running) };
    expect(finished.agents).toHaveLength(0);
  });
});
