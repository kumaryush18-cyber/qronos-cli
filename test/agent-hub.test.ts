import { describe, expect, test } from "bun:test";
import { AgentRegistry, type AgentRecord } from "../src/agent-registry";
import { buildHubLines, hubSummary, moveSelection, transcriptLines, wrap } from "../src/agent-hub-view";
import { AgentHubPanel } from "../src/agent-hub";

function makeRegistry(): AgentRegistry {
  return new AgentRegistry();
}

function seed(registry: AgentRegistry, over: Partial<Parameters<AgentRegistry["start"]>[0]> = {}): AgentRecord {
  return registry.start({
    description: "map auth flow",
    prompt: "Find every place that touches the auth flow.",
    type: "Explore",
    maxTurns: 10,
    ...over,
  });
}

// A theme that does nothing: the view is tested as plain text on purpose.
const plainTheme = { fg: (_token: string, text: string) => text } as any;

describe("agent hub view: the list", () => {
  test("one row per agent, with icon, number and type", () => {
    const registry = makeRegistry();
    const record = seed(registry);
    registry.progress(record.id, { turns: 2, tool: "read" });

    const lines = buildHubLines({ records: registry.list(), selected: 0, width: 68, now: record.startedAt + 5000 });
    const text = lines.map((l) => l.text).join("\n");

    expect(text).toContain("Subagents — 1 running");
    expect(text).toContain("map auth flow");
    expect(text).toContain("Explore · 2/10");
    expect(text).toContain("running read");
  });

  test("a waiting agent says it needs approval, and the hint explains where to answer", () => {
    const registry = makeRegistry();
    const record = seed(registry);
    registry.waitForApproval(record.id);

    const text = buildHubLines({ records: registry.list(), selected: 0, width: 68 }).map((l) => l.text).join("\n");
    expect(text).toContain("needs approval — answer in the chat");
    // The roster never offers to approve: approval lives in the main chat.
    expect(text).not.toContain("y/n");
    expect(text).toContain("Enter open");
  });

  test("a failed agent shows its error on the detail line", () => {
    const registry = makeRegistry();
    const record = seed(registry);
    registry.finish(record.id, { status: "failed", error: "model refused" });

    const text = buildHubLines({ records: registry.list(), selected: 0, width: 68 }).map((l) => l.text).join("\n");
    expect(text).toContain("failed");
    expect(text).toContain("model refused");
  });

  test("an empty registry explains itself instead of showing nothing", () => {
    const text = buildHubLines({ records: [], selected: 0, width: 68 }).map((l) => l.text).join("\n");
    expect(text).toContain("No subagents in this session.");
  });

  test("rows are cut to the panel width so the border never breaks", () => {
    const registry = makeRegistry();
    seed(registry, { description: "a very long description that would otherwise push past the border and break it" });

    const width = 60;
    for (const line of buildHubLines({ records: registry.list(), selected: 0, width, now: 0 })) {
      expect(line.text.length).toBeLessThanOrEqual(width);
    }
  });

  test("the selected row is marked so the user can see where they are", () => {
    const registry = makeRegistry();
    seed(registry, { description: "first" });
    seed(registry, { description: "second" });

    const lines = buildHubLines({ records: registry.list(), selected: 1, width: 68, now: 0 });
    const selected = lines.filter((l) => l.style === "row-selected");
    expect(selected).toHaveLength(1);
    expect(selected[0].text).toContain("second");
  });

  test("a finished-only list still has a header", () => {
    const registry = makeRegistry();
    const record = seed(registry);
    registry.finish(record.id, { status: "done" });

    const text = buildHubLines({ records: registry.list(), selected: 0, width: 68 }).map((l) => l.text).join("\n");
    expect(text).toContain("1 finished");
  });

  test("steering mode shows the box being typed and how to send it", () => {
    const registry = makeRegistry();
    const record = seed(registry);
    registry.progress(record.id, { turns: 1 });

    const text = buildHubLines({ records: registry.list(), selected: 0, width: 68, steering: "use plan mode" })
      .map((l) => l.text)
      .join("\n");
    expect(text).toContain("Send to #1: use plan mode");
    expect(text).toContain("Enter send");
  });
});

describe("agent hub view: the transcript", () => {
  test("shows status, type, tools and the task", () => {
    const registry = makeRegistry();
    const record = seed(registry);
    registry.progress(record.id, { turns: 3, tool: "grep" });
    registry.finish(record.id, { status: "done", outputChars: 812 });

    const text = buildHubLines({ records: registry.list(), selected: 0, width: 68, transcriptFor: registry.get(record.id) })
      .map((l) => l.text)
      .join("\n");
    expect(text).toContain("#1 map auth flow");
    expect(text).toContain("Status: done");
    expect(text).toContain("Tools: grep");
    expect(text).toContain("Report: 812 characters");
    expect(text).toContain("Find every place");
  });

  test("your steering messages are listed, so a steer is not invisible", () => {
    const registry = makeRegistry();
    const record = seed(registry);
    registry.progress(record.id, { turns: 1 });
    registry.steer(record.id, "stop reading, just report");

    const text = transcriptLines(registry.get(record.id)!, 68).map((l) => l.text).join("\n");
    expect(text).toContain("Your messages");
    expect(text).toContain("stop reading, just report");
  });

  test("no tools yet says so instead of showing an empty field", () => {
    const registry = makeRegistry();
    const record = seed(registry);
    expect(transcriptLines(registry.get(record.id)!, 68).map((l) => l.text).join("\n")).toContain("Tools: none yet");
  });
});

describe("agent hub view: helpers", () => {
  test("selection is clamped at both ends", () => {
    expect(moveSelection(0, 3, -1)).toBe(0);
    expect(moveSelection(2, 3, 1)).toBe(2);
    expect(moveSelection(1, 3, 1)).toBe(2);
    expect(moveSelection(0, 0, 1)).toBe(0);
  });

  test("wrap breaks on words and never loses text", () => {
    const lines = wrap("alpha beta gamma delta", 11);
    expect(lines).toEqual(["alpha beta", "gamma delta"]);
    expect(wrap("", 10)).toEqual([]);
    expect(wrap("short", 10)).toEqual(["short"]);
  });

  test("the summary names how many need approval", () => {
    const registry = makeRegistry();
    const first = seed(registry);
    const second = seed(registry, { description: "second" });
    registry.waitForApproval(first.id);
    registry.progress(second.id, { turns: 1 });

    expect(hubSummary(registry.list())).toBe("2 agents · 1 needs approval");
    registry.finish(first.id, { status: "done" });
    registry.finish(second.id, { status: "done" });
    expect(hubSummary(registry.list())).toBe("");
  });
});

describe("agent hub panel: keys", () => {
  const build = () => {
    const registry = makeRegistry();
    const done = { called: 0 };
    let renders = 0;
    const panel = new AgentHubPanel({
      registry,
      theme: plainTheme,
      done: () => done.called++,
      requestRender: () => renders++,
      width: 68,
      now: () => 0,
    });
    return { registry, panel, done, renders: () => renders };
  };

  test("Escape closes the panel from the list", () => {
    const { registry, panel, done } = build();
    seed(registry);
    panel.handleInput("\u001b");
    expect(done.called).toBe(1);
  });

  test("Enter opens the agent's own chat, Escape goes back, Escape again closes", () => {
    const { registry, panel, done } = build();
    seed(registry);
    panel.handleInput("\r");
    expect(panel.mode).toBe("chat");
    panel.handleInput("\u001b");
    expect(panel.mode).toBe("list");
    expect(done.called).toBe(0);
    panel.handleInput("\u001b");
    expect(done.called).toBe(1);
  });

  test("arrows move the selection and stop at the ends", () => {
    const { registry, panel } = build();
    seed(registry, { description: "first" });
    seed(registry, { description: "second" });

    panel.handleInput("\u001b[A");
    expect(panel.selected).toBe(0);
    panel.handleInput("\u001b[B");
    expect(panel.selected).toBe(1);
    panel.handleInput("\u001b[B");
    expect(panel.selected).toBe(1);
  });

  test("k kills the selected agent", () => {
    const { registry, panel } = build();
    const record = seed(registry);
    panel.handleInput("k");
    expect(registry.get(record.id)!.status).toBe("killed");
  });

  test("s types a steer and Enter sends it to the selected agent", () => {
    const { registry, panel } = build();
    const record = seed(registry);
    registry.progress(record.id, { turns: 1 });

    panel.handleInput("s");
    for (const char of "use plan mode") panel.handleInput(char);
    expect(panel.render(68).join("\n")).toContain("use plan mode");

    panel.handleInput("\r");
    expect(registry.get(record.id)!.steering).toEqual(["use plan mode"]);
    expect(panel.steeringFor).toBeUndefined();
  });

  test("steering a finished agent is refused, so a message cannot be lost", () => {
    const { registry, panel } = build();
    const record = seed(registry);
    registry.finish(record.id, { status: "done" });
    panel.handleInput("s");
    expect(panel.steeringFor).toBeUndefined();
  });

  test("r asks the registry to revive the selected agent", () => {
    const { registry, panel } = build();
    const record = seed(registry);
    let revived = 0;
    registry.setReviver(record.id, () => revived++);
    panel.handleInput("r");
    expect(revived).toBe(1);
  });

  test("render fits the width it is given, even a narrow one", () => {
    const { registry, panel } = build();
    seed(registry, { description: "a long description that must be cut to fit" });
    for (const width of [24, 40, 68, 120]) {
      for (const line of panel.render(width)) {
        expect(line.length).toBeLessThanOrEqual(width);
      }
    }
  });

  test("a theme that throws does not break the panel", () => {
    const registry = makeRegistry();
    seed(registry);
    const panel = new AgentHubPanel({
      registry,
      theme: { fg: () => { throw new Error("no such token"); } } as any,
      done: () => {},
      width: 68,
    });
    expect(panel.render(68).length).toBeGreaterThan(2);
  });

  test("dispose stops listening, so a closed panel is not re-rendered", () => {
    const { registry, panel, renders } = build();
    const record = seed(registry);
    panel.dispose();
    const before = renders();
    registry.progress(record.id, { turns: 2 });
    expect(renders()).toBe(before);
  });
});

describe("agent hub panel: inside one agent's chat", () => {
  const build = () => {
    const registry = makeRegistry();
    let renders = 0;
    const panel = new AgentHubPanel({
      registry,
      theme: plainTheme,
      done: () => {},
      requestRender: () => renders++,
      width: 68,
      height: 24,
      now: () => 0,
    });
    return { registry, panel };
  };

  test("the chat shows the task and what the agent did", () => {
    const { registry, panel } = build();
    const record = seed(registry);
    registry.progress(record.id, { turns: 1 });
    record.transcript.push({ kind: "tool-call", text: "read", tool: "read", args: "path: src/a.ts" });
    record.transcript.push({ kind: "tool-result", text: "128 lines", tool: "read" });
    record.transcript.appendAssistant("Found three call sites.", 1);

    panel.handleInput("\r");
    const text = panel.render(68).join("\n");
    expect(text).toContain("Task from the main agent");
    expect(text).toContain("● read  path: src/a.ts");
    expect(text).toContain("✓ 128 lines");
    expect(text).toContain("Found three call sites.");
  });

  test("streamed words appear without pressing anything", () => {
    const { registry, panel } = build();
    const record = seed(registry);
    panel.handleInput("\r");
    record.transcript.appendAssistant("one ", 1);
    registry.progress(record.id, { turns: 1 });
    expect(panel.render(68).join("\n")).toContain("one");
    record.transcript.appendAssistant("two", 1);
    registry.progress(record.id, { turns: 1 });
    expect(panel.render(68).join("\n")).toContain("one two");
  });

  test("PageUp scrolls back and End follows again", () => {
    const { registry, panel } = build();
    const record = seed(registry);
    for (let n = 1; n <= 60; n++) record.transcript.push({ kind: "assistant", text: `line ${n}`, turn: n });
    panel.handleInput("\r");

    panel.handleInput("\u001b[5~"); // pageUp
    expect(panel.scrollBack).toBeGreaterThan(0);
    expect(panel.render(68).join("\n")).toContain("End follow");

    panel.handleInput("\u001b[F"); // end
    expect(panel.scrollBack).toBe(0);
  });

  test("k in the chat stops that agent", () => {
    const { registry, panel } = build();
    const record = seed(registry);
    panel.handleInput("\r");
    panel.handleInput("k");
    expect(registry.get(record.id)!.status).toBe("killed");
  });

  test("s in the chat steers that agent", () => {
    const { registry, panel } = build();
    const record = seed(registry);
    registry.progress(record.id, { turns: 1 });
    panel.handleInput("\r");
    panel.handleInput("s");
    for (const char of "faster") panel.handleInput(char);
    panel.handleInput("\r");
    expect(registry.get(record.id)!.steering).toEqual(["faster"]);
  });

  test("a chat swapped for another agent does not keep the old scroll", () => {
    const { registry, panel } = build();
    const first = seed(registry, { description: "first" });
    seed(registry, { description: "second" });
    for (let n = 1; n <= 60; n++) first.transcript.push({ kind: "assistant", text: `line ${n}`, turn: n });
    panel.handleInput("\r");
    panel.handleInput("\u001b[5~");
    panel.handleInput("\u001b"); // back to the roster
    expect(panel.scrollBack).toBe(0);
  });
});
