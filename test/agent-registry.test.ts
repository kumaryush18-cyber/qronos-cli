import { describe, expect, test } from "bun:test";
import {
  AgentRegistry,
  formatAgentRoster,
  formatAgentSummary,
  formatElapsed,
  shortType,
  statusIcon,
} from "../src/agent-registry";

const start = (registry: AgentRegistry, overrides: Partial<Parameters<AgentRegistry["start"]>[0]> = {}) =>
  registry.start({ description: "map auth", prompt: "find auth", type: "Explore", now: 1000, ...overrides });

describe("registry state machine", () => {
  test("a new agent is running, numbered from 1", () => {
    const registry = new AgentRegistry();
    const record = start(registry);
    expect(record.id).toBe("agent-1");
    expect(record.index).toBe(1);
    expect(record.status).toBe("running");
    expect(record.turns).toBe(0);
    expect(registry.running().length).toBe(1);
  });

  test("progress tracks turns and the last tool without duplicates", () => {
    const registry = new AgentRegistry();
    const record = start(registry);
    registry.progress(record.id, { turns: 1, tool: "read" });
    registry.progress(record.id, { turns: 2, tool: "read" });
    registry.progress(record.id, { turns: 3, tool: "grep" });
    const after = registry.get(record.id)!;
    expect(after.turns).toBe(3);
    expect(after.toolsUsed).toEqual(["read", "grep"]);
    expect(after.lastTool).toBe("grep");
  });

  test("finishing records the end time and the report size", () => {
    const registry = new AgentRegistry();
    const record = start(registry);
    registry.finish(record.id, { status: "done", turns: 4, outputChars: 900, now: 4000 });
    const after = registry.get(record.id)!;
    expect(after.status).toBe("done");
    expect(after.endedAt).toBe(4000);
    expect(after.outputChars).toBe(900);
    expect(registry.running().length).toBe(0);
  });

  test("a finished agent cannot be pushed back to running by a late turn", () => {
    const registry = new AgentRegistry();
    const record = start(registry);
    registry.finish(record.id, { status: "done" });
    registry.finish(record.id, { status: "failed", error: "late" });
    expect(registry.get(record.id)!.status).toBe("done");
    expect(registry.get(record.id)!.error).toBeUndefined();
  });

  test("a failure keeps the error message for the roster", () => {
    const registry = new AgentRegistry();
    const record = start(registry);
    registry.finish(record.id, { status: "failed", error: "model timeout" });
    expect(registry.get(record.id)!.error).toBe("model timeout");
    expect(registry.get(record.id)!.status).toBe("failed");
  });

  test("an agent waiting for plan approval is still active", () => {
    const registry = new AgentRegistry();
    const record = start(registry);
    registry.waitForApproval(record.id);
    expect(registry.running().map((r) => r.status)).toEqual(["waiting-approval"]);
  });

  test("killAll only touches agents that have not finished", () => {
    const registry = new AgentRegistry();
    const done = start(registry, { description: "done one" });
    const live = start(registry, { description: "live one" });
    registry.finish(done.id, { status: "done" });
    const killed = registry.killAll("session ended", 5000);
    expect(killed.map((r) => r.id)).toEqual([live.id]);
    expect(registry.get(live.id)!.status).toBe("killed");
    expect(registry.get(live.id)!.error).toBe("session ended");
    expect(registry.get(done.id)!.status).toBe("done");
  });

  test("subscribe notifies on every change and stops after unsubscribe", () => {
    const registry = new AgentRegistry();
    const seen: number[] = [];
    const off = registry.subscribe((records) => seen.push(records.length));
    const record = start(registry);
    registry.progress(record.id, { turns: 1 });
    registry.finish(record.id, { status: "done" });
    off();
    start(registry);
    expect(seen).toEqual([1, 1, 1]);
  });

  test("a throwing listener cannot stop an agent", () => {
    const registry = new AgentRegistry();
    registry.subscribe(() => {
      throw new Error("broken widget");
    });
    expect(() => start(registry)).not.toThrow();
    expect(registry.list().length).toBe(1);
  });

  test("clear resets ids so a new session starts at agent-1", () => {
    const registry = new AgentRegistry();
    start(registry);
    registry.clear();
    expect(registry.list()).toEqual([]);
    expect(start(registry).id).toBe("agent-1");
  });

  test("unknown ids are ignored rather than throwing", () => {
    const registry = new AgentRegistry();
    expect(registry.progress("nope")).toBeUndefined();
    expect(registry.finish("nope", { status: "done" })).toBeUndefined();
    expect(registry.waitForApproval("nope")).toBeUndefined();
  });
});

describe("roster and summary text", () => {
  test("an empty session says so", () => {
    expect(formatAgentSummary([])).toBe("");
    expect(formatAgentRoster([])).toEqual(["No subagents in this session."]);
  });

  test("running agents show turns against the budget", () => {
    const registry = new AgentRegistry();
    const record = start(registry);
    registry.progress(record.id, { turns: 3 });
    expect(formatAgentSummary(registry.list(), 2000)).toBe("1 agent · Explore 3/10");
  });

  test("an agent waiting for approval is named as such", () => {
    const registry = new AgentRegistry();
    const record = start(registry);
    registry.waitForApproval(record.id);
    expect(formatAgentSummary(registry.list(), 2000)).toContain("needs approval");
  });

  test("more than three running agents collapse into +N", () => {
    const registry = new AgentRegistry();
    for (let i = 0; i < 5; i++) start(registry, { description: `task ${i}` });
    expect(formatAgentSummary(registry.list(), 2000)).toContain("+2");
  });

  test("finished sessions summarise done and failed", () => {
    const registry = new AgentRegistry();
    const a = start(registry);
    const b = start(registry);
    registry.finish(a.id, { status: "done" });
    registry.finish(b.id, { status: "failed" });
    expect(formatAgentSummary(registry.list(), 2000)).toBe("1 done · 1 failed");
  });

  test("roster lines carry icon, index, turns, elapsed time and last tool", () => {
    const registry = new AgentRegistry();
    const record = start(registry, { now: 0 });
    registry.progress(record.id, { turns: 2, tool: "bash" });
    const [line] = formatAgentRoster(registry.list(), 65_000);
    expect(line).toContain("✻");
    expect(line).toContain("1. map auth");
    expect(line).toContain("2/10");
    expect(line).toContain("1m 5s");
    expect(line).toContain("bash");
  });

  test("roster lines show the failure reason, shortened", () => {
    const registry = new AgentRegistry();
    const record = start(registry);
    registry.finish(record.id, { status: "failed", error: "x".repeat(80) });
    const [line] = formatAgentRoster(registry.list(), 2000);
    expect(line).toContain("✗");
    expect(line).toContain("…");
  });

  test("helpers behave for the edge values", () => {
    expect(statusIcon("queued")).toBe("·");
    expect(statusIcon("killed")).toBe("⊘");
    expect(shortType("general-purpose")).toBe("General");
    expect(shortType("Plan")).toBe("Plan");
    expect(shortType("custom-thing")).toBe("custom-thing");
    expect(formatElapsed(-5)).toBe("0s");
    expect(formatElapsed(59_400)).toBe("59s");
    expect(formatElapsed(3_600_000)).toBe("60m 0s");
  });
});
