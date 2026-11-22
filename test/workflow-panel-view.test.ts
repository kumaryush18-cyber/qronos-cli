import { describe, expect, test } from "bun:test";
import {
  buildPanelLines,
  columnWidths,
  moveIndex,
  panelBar,
  panelSummary,
  shortModel,
  toPanelJob,
  withAnswers,
  wrap,
  type PanelJobView,
  type PanelState,
} from "../src/workflow-panel-view";
import type { WorkflowJob } from "../src/workflow-jobs";
import type { WorkflowEvent } from "../src/workflow-types";

const job = (overrides: Partial<WorkflowJob> = {}): WorkflowJob => ({
  id: "wf_abc12301",
  name: "analyze-src",
  description: "Map the source tree by purpose using 5 parallel subagents",
  planned: [{ title: "Analyze", agents: 5 }],
  state: "running",
  script: "// audit\nexport const meta = { name: 'x' }\nphase('Review')\nconst out = await agent('list files')\nreturn out.text",
  startedAt: 1_000,
  running: 2,
  done: 1,
  failed: 0,
  tokens: { input: 900, output: 100, total: 1_000 },
  replayed: 0,
  replayedTokens: { input: 0, output: 0, total: 0 },
  phases: ["Analyze"],
  phaseStats: [{ name: "Analyze", agents: 3, failed: 0, tokens: 1_000, durationMs: 100 }],
  agents: [
    { id: "#0", label: "coding-agent", ok: true, durationMs: 29_000, usage: { input: 1, output: 1, total: 4_300 }, depth: 1, phase: "Analyze", model: "deepseek/deepseek-v4-flash" },
    { id: "#1", label: "ai-and-tui", ok: false, error: "no answer", durationMs: 4_000, depth: 1, phase: "Analyze", model: "deepseek/deepseek-v4-flash" },
  ],
  // Live agents live in the map, not in the event window: sixteen agents making
  // forty tool calls each would push every `agent_start` out of a sixty-line
  // window, and the panel would go blank while the run is busiest.
  live: new Map([
    [
      "#2",
      {
        id: "#2",
        label: "ts-support",
        phase: "Analyze",
        prompt: "List the TypeScript helper packages.",
        startedAt: 60_000,
        activity: [{ tool: "Bash", turns: 1, at: 60_500 }],
        toolCalls: 1,
      },
    ],
    [
      "#3",
      {
        id: "#3",
        label: "rust-shell",
        phase: "Analyze",
        startedAt: 60_000,
        activity: [],
        toolCalls: 0,
      },
    ],
  ]),
  recent: [] as WorkflowEvent[],
  settled: Promise.resolve() as unknown as Promise<WorkflowJob>,
  ...overrides,
});

const view = (overrides: Partial<WorkflowJob> = {}) => toPanelJob(job(overrides), 61_000);

const state = (overrides: Partial<PanelState> = {}): PanelState => {
  const built = view();
  return {
    jobs: [built],
    job: built,
    selectedPhase: 0,
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
  test("carries the numbers the header shows", () => {
    const built = view();
    expect(built.done).toBe(1);
    expect(built.planned).toBe(5);
    expect(built.elapsedMs).toBe(60_000);
  });

  test("keeps the description the script declared", () => {
    expect(view().description).toContain("Map the source tree");
  });

  test("builds phases from the plan before they start", () => {
    const built = toPanelJob(job({ planned: [{ title: "Analyze", agents: 5 }, { title: "Review", agents: 2 }], phases: [] }), 61_000);
    expect(built.phases.map((phase) => phase.name)).toEqual(["Analyze", "Review"]);
  });

  test("agents still working get a row each", () => {
    const built = view();
    const running = built.agents.filter((agent) => agent.running);
    expect(running.map((agent) => agent.label).sort()).toEqual(["rust-shell", "ts-support"]);
  });

  test("planned agents that have not started are queued", () => {
    const built = view();
    const queued = built.agents.filter((agent) => agent.queued);
    // 5 planned, 2 finished, 2 running = 1 queued
    expect(queued).toHaveLength(1);
  });

  test("a finished job has nothing queued", () => {
    const built = toPanelJob(job({ state: "done", finishedAt: 61_000, planned: [] }), 61_000);
    expect(built.agents.filter((agent) => agent.queued)).toHaveLength(0);
  });

  test("a live agent carries its prompt and its tool calls", () => {
    const built = view();
    const live = built.agents.find((agent) => agent.label === "ts-support");
    expect(live?.prompt).toContain("TypeScript helper packages");
    expect(live?.toolCalls).toBe(1);
    expect(live?.activity?.[0]?.tool).toBe("Bash");
  });

  test("a finished agent keeps its prompt, activity and count", () => {
    const built = toPanelJob(
      job({
        agents: [
          {
            id: "#9",
            label: "done-one",
            ok: true,
            durationMs: 5_000,
            depth: 1,
            phase: "Analyze",
            prompt: "Read the routes.",
            activity: [
              { tool: "grep", turns: 1, at: 1 },
              { tool: "read", turns: 2, at: 2 },
            ],
            toolCalls: 2,
          },
        ],
        live: new Map(),
      }),
      61_000,
    );
    const record = built.agents.find((agent) => agent.label === "done-one");
    expect(record?.prompt).toBe("Read the routes.");
    expect(record?.toolCalls).toBe(2);
    expect(record?.activity?.map((row) => row.tool)).toEqual(["grep", "read"]);
  });

  test("the model travels with the agent", () => {
    expect(view().agents[0]!.model).toContain("deepseek");
  });

  test("agents with no phase get one bucket, so the right column is not empty", () => {
    const built = toPanelJob(
      job({
        planned: [],
        phases: [],
        phaseStats: [],
        running: 0,
        agents: [{ id: "#0", label: "solo", ok: true, durationMs: 1, depth: 1 }],
        live: new Map(),
  recent: [],
      }),
      61_000,
    );
    expect(built.phases).toHaveLength(1);
    expect(built.phases[0]!.name).toBe("Agents");
  });
});

describe("the header", () => {
  test("the name is on the left and done/total agents and time on the right", () => {
    const lines = text(buildPanelLines(state()));
    expect(lines).toContain("analyze-src");
    expect(lines).toContain("1/5 agents");
    expect(lines).toContain("1m 00s");
  });

  test("the description sits under the title", () => {
    const line = buildPanelLines(state()).find((entry) => entry.style === "description");
    expect(line?.text).toContain("Map the source tree");
  });

  test("the second line says failed and replayed and tokens when they matter", () => {
    const lines = text(buildPanelLines(state({ job: toPanelJob(job({ replayed: 2, failed: 1 }), 61_000) })));
    expect(lines).toContain("1 failed");
    expect(lines).toContain("2 replayed");
    expect(lines).toContain("1k tokens");
  });

  test("a paused run says paused", () => {
    expect(text(buildPanelLines(state({ job: view({ state: "paused" }) })))).toContain("paused");
  });
});

describe("the two columns", () => {
  test("the column heads are Phases and the selected phase", () => {
    const lines = buildPanelLines(state());
    const head = lines.find((line) => line.style === "column-head");
    expect(head?.text).toContain("Phases");
    expect(head?.text).toContain("│");
    expect(head?.text).toContain("Analyze · 5 agents");
  });

  test("a phase row is numbered, cursor-marked and counted", () => {
    const lines = text(buildPanelLines(state()));
    expect(lines).toContain("▸ 1 Analyze 2/5");
  });

  test("the cursor follows the selected phase", () => {
    const two = toPanelJob(
      job({ planned: [{ title: "Analyze", agents: 2 }, { title: "Review", agents: 2 }] }),
      61_000,
    );
    const lines = text(buildPanelLines(state({ job: two, selectedPhase: 1 })));
    expect(lines).toContain("  1 Analyze");
    expect(lines).toContain("▸ 2 Review");
  });

  test("a phase row and its agents share a line", () => {
    const rows = buildPanelLines(state()).filter((line) => line.text.includes("│"));
    expect(rows.length).toBeGreaterThan(1);
  });

  test("agent rows show a glyph, the name, tokens and the time", () => {
    const lines = text(buildPanelLines(state()));
    expect(lines).toContain("✓ coding-agent");
    expect(lines).toContain("4.3k tokens");
    expect(lines).toContain("29s");
  });

  test("a running agent says 0 tokens rather than nothing", () => {
    expect(text(buildPanelLines(state()))).toMatch(/✻ ts-support .*0 tokens/);
  });

  test("a running agent uses the working glyph", () => {
    expect(text(buildPanelLines(state()))).toContain("✻ ts-support");
  });

  test("a queued agent says queued instead of a time", () => {
    const lines = text(buildPanelLines(state()));
    // Its name is unknown until it starts, so the row says "waiting" and the
    // right-hand side says "queued".
    expect(lines).toMatch(/↻ waiting.*queued/);
  });

  test("a failed agent shows a cross next to its name", () => {
    const lines = text(buildPanelLines(state()));
    expect(lines).toContain("✗ ai-and-tui");
  });

  test("the phase that is working is marked for the shimmer", () => {
    const active = buildPanelLines(state()).filter((line) => line.style === "phase-active");
    expect(active.length).toBeGreaterThan(0);
  });

  test("the footer offers pause, stop, save, view, keys", () => {
    const lines = text(buildPanelLines(state()));
    expect(lines).toContain("p pause");
    expect(lines).toContain("x stop");
    expect(lines).toContain("s save");
    // `a` reruns a whole phase, which is the key that saves the most hand work.
    expect(lines).toContain("a rerun");
    expect(lines).toContain("enter view");
    expect(lines).toContain("esc close");
  });

  test("a paused run offers resume", () => {
    expect(text(buildPanelLines(state({ job: view({ state: "paused" }) })))).toContain("p resume");
  });

  test("an empty state explains how to start", () => {
    const lines = text(buildPanelLines(state({ job: undefined })));
    expect(lines).toContain("Nothing has run in this session yet.");
    expect(lines).toContain("ultracode");
  });

  test("every line fits the panel width", () => {
    for (const width of [40, 60, 74, 120]) {
      for (const line of buildPanelLines(state({ width }))) {
        expect(line.text.length).toBeLessThanOrEqual(width - 2);
      }
    }
  });

  test("a long run is cut, not wrapped, and says how many are hidden", () => {
    const many = Array.from({ length: 20 }, (_, index) => ({
      id: `#${index}`,
      label: `agent-${index}`,
      ok: true,
      durationMs: 1_000,
      usage: { input: 1, output: 1, total: 100 + index },
      depth: 1,
      phase: "Analyze",
    }));
    const built = toPanelJob(job({ agents: many, planned: [{ title: "Analyze", agents: 20 }], running: 0 }), 61_000);
    const lines = text(buildPanelLines(state({ job: built })));
    expect(lines).toContain("more agents in Analyze");
  });
});

const finishedJob = () =>
  toPanelJob(
    job({
      state: "done",
      finishedAt: 61_000,
      running: 0,
      planned: [],
      phases: ["Analyze"],
      live: new Map(),
  recent: [],
    }),
    61_000,
  );

describe("the agent view", () => {
  /** A finished agent with a prompt, tool calls and an answer. */
  const detailed = () =>
    toPanelJob(
      job({
        state: "done",
        finishedAt: 61_000,
        running: 0,
        planned: [],
        phases: ["Analyze"],
        live: new Map(),
        agents: [
          {
            id: "#7",
            label: "coding-agent",
            ok: true,
            durationMs: 29_000,
            depth: 1,
            phase: "Analyze",
            model: "deepseek/deepseek-v4-flash",
            usage: { input: 4_000, output: 300, total: 4_300 },
            prompt: [
              "Area: TypeScript coding agent core.",
              "Read package.json and skim the main files.",
              "Group by PURPOSE: agent loop, tools, providers, UI.",
              "Say which package is the biggest.",
            ].join("\n"),
            activity: [
              { tool: "Bash", detail: "cd src && wc -l index.ts", turns: 1, at: 1 },
              { tool: "read", detail: "path: package.json", turns: 2, at: 2 },
              { tool: "grep", detail: "pattern: tool", turns: 3, at: 3 },
              { tool: "ls", detail: "path: src", turns: 4, at: 4 },
            ],
            toolCalls: 6,
          },
        ],
      }),
      61_000,
    );

  const shown = (overrides: Partial<PanelState> = {}) =>
    text(buildPanelLines(state({ job: detailed(), mode: "agent", selectedAgent: 0, ...overrides })));

  test("a restarted agent says how many attempts it has had", () => {
    const view = detailed();
    const agent = view.agents[0]!;
    agent.restarted = true;
    agent.attempts = 2;
    const shownView = text(buildPanelLines(state({ job: view, mode: "agent", selectedAgent: 0 })));
    expect(shownView).toContain("attempt 3");
    expect(shownView).toContain("ran again 2 times");
  });

  test("an edited task is marked in the prompt block", () => {
    const view = detailed();
    const agent = view.agents[0]!;
    agent.editedPrompt = true;
    const shownView = text(buildPanelLines(state({ job: view, mode: "agent", selectedAgent: 0 })));
    expect(shownView).toContain("· edited");
  });

  test("a plain agent shows no attempt line and no edit mark", () => {
    const shownAll = shown();
    expect(shownAll).not.toContain("attempt ");
    expect(shownAll).not.toContain("· edited");
  });

  test("it keeps a list of agents on the left and the chosen one on the right", () => {
    const lines = buildPanelLines(state({ job: detailed(), mode: "agent", selectedAgent: 0 }));
    expect(lines[0]!.text).toContain("Agents · Analyze");
    expect(lines[0]!.text).toContain("coding-agent");
    // The divider means two columns, not one long page.
    expect(lines.some((line) => line.text.includes("│"))).toBe(true);
  });

  test("the status line names the model, the tokens, the tools and the time", () => {
    const lines = shown();
    expect(lines).toContain("deepseek-v4-flash");
    expect(lines).toContain("4.3k tokens · 6 tools · took 29s");
  });

  test("the size of the context sits beside the model name", () => {
    const built = detailed();
    built.agents[0]!.contextWindow = 1_000_000;
    const lines = text(buildPanelLines(state({ job: built, mode: "agent", selectedAgent: 0 })));
    expect(lines).toContain("deepseek-v4-flash [1m]");
  });

  test("an unknown size leaves the name alone, not a guess", () => {
    const lines = shown();
    expect(lines).toContain("deepseek-v4-flash");
    expect(lines).not.toMatch(/deepseek-v4-flash \[/);
  });

  test("a smaller window says 200k", () => {
    const built = detailed();
    built.agents[0]!.contextWindow = 200_000;
    const lines = text(buildPanelLines(state({ job: built, mode: "agent", selectedAgent: 0 })));
    expect(lines).toContain("deepseek-v4-flash [200k]");
  });

  test("a running agent says idle instead of took", () => {
    const built = view();
    const lines = text(buildPanelLines(state({ job: built, mode: "agent", selectedAgent: 0 })));
    expect(lines).toMatch(/idle \d+s/);
  });

  test("the three blocks are Prompt, Activity and Outcome", () => {
    const lines = shown();
    // The count is display lines, which is what `enter` will reveal.
    expect(lines).toMatch(/Prompt · \d+ lines · ↵ expand/);
    expect(lines).toContain("Activity · last 3 of 6 · ↵ expand");
    expect(lines).toContain("Outcome");
  });

  test("a closed prompt shows two lines and says how many are hidden", () => {
    const lines = shown();
    expect(lines).toMatch(/Area: TypeScript coding agent core\./);
    expect(lines).toMatch(/… \d+ more lines/);
  });

  test("an open prompt shows more lines", () => {
    const lines = shown({ expanded: { prompt: true } });
    expect(lines).toContain("↵ collapse");
    expect(lines).toMatch(/is the biggest\./);
  });

  test("a closed activity shows the last three calls with their arguments", () => {
    const lines = shown();
    expect(lines).toMatch(/read\(path: package\.json\)/);
    expect(lines).toMatch(/grep\(pattern: tool\)/);
    expect(lines).toMatch(/ls\(path: src\)/);
    // The oldest call is the one that falls out of the window.
    expect(lines).not.toMatch(/Bash\(cd src/);
  });

  test("an open activity shows the row it was hiding", () => {
    expect(shown({ expanded: { activity: true } })).toMatch(/Bash\(cd src && wc -l index\.ts\)/);
  });

  test("the cursor sits on the block you picked", () => {
    expect(shown({ selectedBlock: 0 })).toContain("▸ Prompt");
    expect(shown({ selectedBlock: 1 })).toContain("▸ Activity");
    expect(shown({ selectedBlock: 2 })).toContain("▸ Outcome");
    expect(shown({ selectedBlock: 1 })).not.toContain("▸ Prompt");
  });

  test("an agent with no tool calls says so rather than showing an empty block", () => {
    const built = toPanelJob(
      job({
        state: "done",
        running: 0,
        planned: [],
        live: new Map(),
        agents: [{ id: "#8", label: "quiet", ok: true, durationMs: 1_000, depth: 1, phase: "Analyze" }],
      }),
      61_000,
    );
    const lines = text(buildPanelLines(state({ job: built, mode: "agent" })));
    expect(lines).toContain("Activity · no tool calls");
    expect(lines).toContain("Prompt · not kept");
  });

  test("a running agent's outcome says Still running", () => {
    expect(text(buildPanelLines(state({ mode: "agent" })))).toContain("Still running…");
  });

  test("the latest tool call of a running agent is marked as happening now", () => {
    expect(text(buildPanelLines(state({ mode: "agent" })))).toContain("· now");
  });

  test("a finished agent shows its answer under Outcome", () => {
    const built = withAnswers(detailed(), { "#7": "The coding-agent package is the biggest." });
    const lines = text(buildPanelLines(state({ job: built, mode: "agent" })));
    expect(lines).toMatch(/The coding-agent package is the/);
  });

  test("an error is shown under Outcome", () => {
    const built = finishedJob();
    const lines = text(buildPanelLines(state({ job: built, mode: "agent", selectedAgent: 0 })));
    expect(lines).toContain("no answer");
  });

  test("a long answer is cut and offers to open", () => {
    const built = withAnswers(detailed(), { "#7": `${"word ".repeat(120)}` });
    const lines = text(buildPanelLines(state({ job: built, mode: "agent" })));
    expect(lines).toContain("more lines · enter expand");
  });

  test("the footer lists the keys of the detail view", () => {
    const lines = shown();
    expect(lines).toContain("↑↓ agent");
    expect(lines).toContain("tab block");
    expect(lines).toContain("↵ expand");
    expect(lines).toContain("r rerun");
    // `k` stops one agent, `x` stops the run: two sizes of the same decision.
    expect(lines).toContain("k stop one");
    // The whole line must fit the default width: a hint that is cut off is a key
    // nobody finds.
    expect(lines).toContain("esc back");
  });

  test("queued agents are not in the detail list", () => {
    // An arrow key that lands on "waiting" and shows an empty screen is a trap.
    const lines = text(buildPanelLines(state({ mode: "agent" })));
    expect(lines).not.toContain("↻ waiting");
  });

  test("every detail line fits the panel width", () => {
    for (const width of [40, 60, 74, 120]) {
      for (const line of buildPanelLines(state({ job: detailed(), mode: "agent", width }))) {
        expect(line.text.length).toBeLessThanOrEqual(width - 2);
      }
    }
  });
});

describe("helpers", () => {
  test("columns leave room for both sides", () => {
    expect(columnWidths(74).left + columnWidths(74).right).toBeLessThan(74);
    expect(columnWidths(74).left).toBeGreaterThanOrEqual(20);
  });

  test("a model name is shortened to its last part", () => {
    expect(shortModel("deepseek/deepseek-v4-flash")).toBe("deepseek-v4-flash");
    expect(shortModel(undefined)).toBe("");
    expect(shortModel("a".repeat(40)).length).toBeLessThanOrEqual(22);
  });

  test("bars are exact", () => {
    expect(panelBar(0, 100, 8)).toBe(" ".repeat(8));
    expect(panelBar(100, 100, 8)).toBe("█".repeat(8));
    expect(panelBar(5, 0, 4)).toBe("█".repeat(4));
  });

  test("moveIndex stays inside", () => {
    expect(moveIndex(0, 3, -1)).toBe(0);
    expect(moveIndex(2, 3, 1)).toBe(2);
    expect(moveIndex(0, 0, 1)).toBe(0);
  });

  test("wrap keeps words and splits a very long one", () => {
    expect(wrap("one two three", 40).join(" ")).toBe("one two three");
    expect(wrap("", 40)).toHaveLength(0);
    expect(wrap("a".repeat(30), 10).length).toBeGreaterThan(1);
  });

  test("panelSummary is one line", () => {
    expect(panelSummary(view())).toContain("1/5 agents");
    expect(panelSummary(view({ state: "done" }))).toContain("✓");
    expect(panelSummary(undefined)).toBe("");
  });

  test("withAnswers does not mutate the view", () => {
    const before = view();
    const after = withAnswers(before, { "#0": "x" });
    expect((before as { answers?: unknown }).answers).toBeUndefined();
    expect((after as { answers?: Record<string, string> }).answers!["#0"]).toBe("x");
  });
});

describe("the panelJobView type stays honest", () => {
  test("the view has no methods and no job reference", () => {
    const built: PanelJobView = view();
    expect(Object.keys(built).every((key) => typeof (built as unknown as Record<string, unknown>)[key] !== "function")).toBe(true);
  });
});

describe("an agent you stopped", () => {
  const stoppedJob = () =>
    job({
      state: "done",
      running: 0,
      done: 1,
      failed: 0,
      agents: [
        {
          id: "#0",
          label: "read-the-tests",
          ok: false,
          error: "stopped by you",
          stopped: true,
          durationMs: 2_000,
          usage: { input: 900, output: 100, total: 1_000 },
          depth: 1,
          phase: "Analyze",
          model: "claude-haiku-5.5",
        },
      ],
      live: new Map(),
    });

  test("the row says stopped, and never failed", () => {
    const shown = text(buildPanelLines(state({ job: toPanelJob(stoppedJob(), 70_000) })));
    // The list row has room for the glyph, not for the sentence.
    expect(shown).toContain("⊘ read-the-tests");
    expect(shown).not.toContain("✗");
  });

  test("the detail view says stopped by you, not failed", () => {
    const shown = text(buildPanelLines(state({ job: toPanelJob(stoppedJob(), 70_000), mode: "agent" })));
    expect(shown).toContain("⊘ Stopped by you");
    expect(shown).not.toContain("Failed");
  });

  test("a stopped agent is not counted as a failure in the summary", () => {
    const built = toPanelJob(stoppedJob(), 70_000);
    expect(built.failed).toBe(0);
    expect(panelSummary(built)).not.toContain("failed");
  });
});