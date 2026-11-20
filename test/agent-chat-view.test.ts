import { describe, expect, test } from "bun:test";
import { AgentRegistry, type AgentRecord } from "../src/agent-registry";
import { buildChatBody, buildChatLines, maxScroll, moveScroll, wrap } from "../src/agent-chat-view";

function seed(items: (record: AgentRecord, registry: AgentRegistry) => void = () => {}): {
  record: AgentRecord;
  registry: AgentRegistry;
} {
  const registry = new AgentRegistry();
  const record = registry.start({
    description: "map auth flow",
    prompt: "Find every place that touches the auth flow, then list the files.",
    type: "Explore",
    maxTurns: 10,
    now: 1_000,
  });
  items(record, registry);
  return { record: registry.get(record.id)!, registry };
}

describe("agent chat view: the task and the words", () => {
  test("the task from the main agent is the first block", () => {
    const { record } = seed((r) => {
      r.transcript.push({ kind: "task", text: "Find every place that touches the auth flow, then list the files." });
    });
    const text = buildChatBody(record, 68).map((l) => l.text).join("\n");
    expect(text).toContain("Task from the main agent");
    expect(text).toContain("Find every place");
  });

  test("the subagent's own words show under its name", () => {
    const { record } = seed((r) => {
      r.transcript.push({ kind: "task", text: "task" });
      r.transcript.appendAssistant("I will start with the auth folder.", 1);
    });
    const text = buildChatBody(record, 68).map((l) => l.text).join("\n");
    expect(text).toContain("✻ Subagent");
    expect(text).toContain("I will start with the auth folder.");
  });

  test("streamed pieces arrive as one growing paragraph", () => {
    const { record } = seed((r) => {
      for (const piece of ["Found ", "three ", "call sites."]) r.transcript.appendAssistant(piece, 2);
    });
    const text = buildChatBody(record, 68).map((l) => l.text).join("\n");
    expect(text).toContain("Found three call sites.");
  });

  test("reasoning is collapsed to one dim line", () => {
    const { record } = seed((r) => {
      r.transcript.appendThinking("x".repeat(200), 1);
    });
    const dim = buildChatBody(record, 68).filter((line) => line.text.includes("reasoned"));
    expect(dim).toHaveLength(1);
    expect(dim[0]!.text).toContain("reasoned 200 characters");
    expect(dim[0]!.style).toBe("dim");
  });
});

describe("agent chat view: tools", () => {
  test("a tool call shows its name and arguments", () => {
    const { record } = seed((r) => {
      r.transcript.push({ kind: "tool-call", text: "read", tool: "read", args: "path: src/auth/session.ts" });
    });
    const text = buildChatBody(record, 68).map((l) => l.text).join("\n");
    expect(text).toContain("● read  path: src/auth/session.ts");
  });

  test("a successful result gets a tick, a failed one a cross", () => {
    const { record } = seed((r) => {
      r.transcript.push({ kind: "tool-result", text: "128 lines", tool: "read" });
      r.transcript.push({ kind: "tool-result", text: "no such file", tool: "read", failed: true });
    });
    const lines = buildChatBody(record, 68);
    const ok = lines.find((line) => line.text.includes("✓ 128 lines"));
    const bad = lines.find((line) => line.text.includes("✗ no such file"));
    expect(ok?.style).toBe("tool-ok");
    expect(bad?.style).toBe("tool-fail");
  });

  test("only the first lines of a long result are shown", () => {
    const { record } = seed((r) => {
      r.transcript.push({ kind: "tool-result", text: `line ${"a".repeat(400)}\nsecond\nthird\nfourth`, tool: "read" });
    });
    const lines = buildChatBody(record, 60).filter((line) => line.style === "tool-ok" || line.style === "tool-fail");
    expect(lines.length).toBeLessThanOrEqual(3);
    for (const line of lines) expect(line.text.length).toBeLessThanOrEqual(56);
  });
});

describe("agent chat view: you, errors and retries", () => {
  test("a steer is clearly yours", () => {
    const { record } = seed((r) => {
      r.transcript.push({ kind: "steer", text: "stop reading, just report" });
    });
    const text = buildChatBody(record, 68).map((l) => l.text).join("\n");
    expect(text).toContain("→ you: stop reading, just report");
  });

  test("a retry notice appears in the log", () => {
    const { record } = seed((r) => {
      r.transcript.push({ kind: "notice", text: "Retrying in 10s · attempt 1/10 — 503 service unavailable" });
    });
    const notice = buildChatBody(record, 68).find((line) => line.text.includes("Retrying in 10s"));
    expect(notice?.style).toBe("notice");
  });

  test("the header says 'retrying' while a retry waits", () => {
    const registry = new AgentRegistry();
    const record = registry.start({
      description: "map auth flow",
      prompt: "p",
      type: "Explore",
      maxTurns: 10,
      now: 0,
    });
    registry.progress(record.id, { retry: { attempt: 2, maxAttempts: 10, delayMs: 30_000, error: "503" } });
    const text = buildChatLines({ record: registry.get(record.id)!, width: 68, height: 8, now: 1000 })
      .map((l) => l.text)
      .join("\n");
    expect(text).toContain("retrying (2/10)");
    expect(text).toContain("✻ retrying in 30s · attempt 2/10");
  });

  test("a waiting agent points at the main chat for approval", () => {
    const registry = new AgentRegistry();
    const record = registry.start({ description: "plan", prompt: "p", type: "Plan", maxTurns: 10, now: 0 });
    registry.waitForApproval(record.id);
    const text = buildChatLines({ record: registry.get(record.id)!, width: 68, height: 8, now: 1000 })
      .map((l) => l.text)
      .join("\n");
    expect(text).toContain("needs approval — answer in the main chat");
  });

  test("an error line is marked as an error", () => {
    const { record } = seed((r) => {
      r.transcript.push({ kind: "error", text: "Model request failed: 503" });
    });
    expect(buildChatBody(record, 68).some((line) => line.style === "error")).toBe(true);
  });
});

describe("agent chat view: the window", () => {
  const longLog = () => {
    return seed((r) => {
      for (let n = 1; n <= 40; n++) r.transcript.push({ kind: "assistant", text: `message number ${n}`, turn: n });
    });
  };

  test("without scrolling, the newest lines are shown", () => {
    const { record } = longLog();
    const lines = buildChatLines({ record, width: 68, height: 6, now: 5_000 });
    const text = lines.map((l) => l.text).join("\n");
    expect(text).toContain("message number 40");
    expect(text).not.toContain("message number 5\n");
  });

  test("scrolling up shows older lines and says so in the footer", () => {
    const { record } = longLog();
    const limit = maxScroll(record, 68, 6);
    const lines = buildChatLines({ record, width: 68, height: 6, scrollBack: limit, now: 5_000 });
    const text = lines.map((l) => l.text).join("\n");
    expect(text).toContain("message number 1");
    expect(text).toContain("End follow");
  });

  test("scrolling past the top is clamped, not wrapped", () => {
    const { record } = longLog();
    const limit = maxScroll(record, 68, 6);
    const lines = buildChatLines({ record, width: 68, height: 6, scrollBack: limit + 999, now: 5_000 });
    expect(lines.map((l) => l.text).join("\n")).toContain("message number 1");
  });

  test("the panel keeps its height when the log is short", () => {
    const { record } = seed((r) => r.transcript.push({ kind: "task", text: "short" }));
    const lines = buildChatLines({ record, width: 68, height: 10, now: 1_000 });
    // 2 header + rule + 10 body + rule + hint
    expect(lines).toHaveLength(15);
  });

  test("every line fits the width", () => {
    const { record } = longLog();
    for (const width of [24, 40, 68, 120]) {
      for (const line of buildChatLines({ record, width, height: 8, now: 5_000 })) {
        expect(line.text.length).toBeLessThanOrEqual(width);
      }
    }
  });

  test("an empty log says so instead of showing nothing", () => {
    const registry = new AgentRegistry();
    const record = registry.start({ description: "d", prompt: "p", type: "Explore", maxTurns: 10, now: 0 });
    record.transcript.clear();
    expect(buildChatBody(record, 68)[0]!.text).toContain("Nothing recorded yet");
  });

  test("hidden older entries are announced", () => {
    const registry = new AgentRegistry();
    const record = registry.start({
      description: "d",
      prompt: "p",
      type: "Explore",
      maxTurns: 10,
      now: 0,
      transcript: undefined,
    });
    for (let n = 0; n < 305; n++) record.transcript.push({ kind: "assistant", text: `m${n}` });
    expect(buildChatBody(record, 68)[0]!.text).toContain("earlier lines hidden");
  });
});

describe("agent chat view: helpers", () => {
  test("moveScroll stays inside the limits", () => {
    expect(moveScroll(0, 10, -5)).toBe(0);
    expect(moveScroll(9, 10, 3)).toBe(10);
    expect(moveScroll(5, 10, -2)).toBe(3);
  });

  test("wrap never loses words", () => {
    expect(wrap("alpha beta gamma", 10)).toEqual(["alpha beta", "gamma"]);
    expect(wrap("", 10)).toEqual([]);
  });

  test("maxScroll is zero when everything fits", () => {
    const { record } = seed((r) => r.transcript.push({ kind: "task", text: "one line" }));
    expect(maxScroll(record, 68, 40)).toBe(0);
  });
});