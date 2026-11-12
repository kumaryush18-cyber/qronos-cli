import { describe, expect, test } from "bun:test";
import {
  DEFAULT_MAX_CONCURRENT_SUBAGENTS,
  DEFAULT_MAX_SUBAGENT_DEPTH,
  MUTATING_TOOLS,
  READ_ONLY_TOOLS,
  SUBAGENT_ALWAYS_DENIED,
  maxConcurrentSubagents,
  maxSubagentDepth,
  resolveSubagentTools,
} from "../src/agent-tools";

const PARENT_ALL = [
  "read",
  "grep",
  "glob",
  "write",
  "edit",
  "bash",
  "exit_plan_mode",
  "agent",
  "qronos-agent",
];

function resolve(over: Partial<Parameters<typeof resolveSubagentTools>[0]> = {}) {
  return resolveSubagentTools({
    parentTools: PARENT_ALL,
    parentCanWrite: true,
    depth: 1,
    maxDepth: 3,
    ...over,
  });
}

describe("subagent tools: inheritance invariant", () => {
  test("a read-only parent forces a read-only subagent even if it asks for writes", () => {
    const { tools, dropped } = resolve({
      agentTools: ["read", "write", "edit", "bash"],
      parentCanWrite: false,
    });
    expect(tools.has("write")).toBe(false);
    expect(tools.has("edit")).toBe(false);
    expect(tools.has("bash")).toBe(false);
    expect(tools.has("read")).toBe(true);
    expect(dropped.write).toContain("parent session is read-only");
  });

  test("a writable parent with an acceptEdits-style request may write", () => {
    const { tools } = resolve({ agentTools: ["read", "write", "edit"], parentCanWrite: true });
    expect(tools.has("write")).toBe(true);
    expect(tools.has("edit")).toBe(true);
  });

  test("inherits the parent pool when the definition names no tools", () => {
    const { tools } = resolve({});
    expect(tools.has("read")).toBe(true);
    expect(tools.has("write")).toBe(true);
  });

  test("never gains a mutating tool the parent does not hold", () => {
    const { tools } = resolve({ parentTools: ["read", "grep"], agentTools: ["read", "write"] });
    expect(tools.has("write")).toBe(false);
  });

  test("every mutating tool is gated, including bash", () => {
    for (const name of MUTATING_TOOLS) {
      const { tools } = resolve({ agentTools: [name], parentCanWrite: false });
      expect(tools.has(name)).toBe(false);
    }
  });
});

describe("subagent tools: deny-list is applied first", () => {
  test("disallowedTools removes a tool even when it is also allowed", () => {
    const { tools, dropped } = resolve({
      agentTools: ["read", "grep", "bash"],
      disallowedTools: ["bash"],
    });
    expect(tools.has("bash")).toBe(false);
    expect(dropped.bash).toBe("listed in disallowedTools");
    expect(tools.has("grep")).toBe(true);
  });

  test("deny beats inheritance: a denied tool the parent holds is still removed", () => {
    const { tools } = resolve({ disallowedTools: ["write"] });
    expect(tools.has("write")).toBe(false);
  });

  test("denial is case- and whitespace-insensitive", () => {
    const { tools } = resolve({ agentTools: ["read", "Bash "], disallowedTools: [" bash"] });
    expect(tools.has("bash")).toBe(false);
  });
});

describe("subagent tools: always-denied filter", () => {
  test("user-facing and session-ending tools are stripped from every subagent", () => {
    for (const name of SUBAGENT_ALWAYS_DENIED) {
      const { tools } = resolve({ agentTools: [name], disallowedTools: [] });
      expect(tools.has(name)).toBe(false);
    }
  });

  test("agent tool is stripped below the depth limit but reported as depth-only when over", () => {
    const shallow = resolve({ depth: 1, maxDepth: 3 });
    expect(shallow.tools.has("agent")).toBe(false);
    const deep = resolve({ depth: 4, maxDepth: 3 });
    expect(deep.dropped.agent).toContain("depth limit");
  });
});

describe("subagent tools: depth limit", () => {
  test("agent tool is withheld past the limit", () => {
    const { tools } = resolve({ depth: 4, maxDepth: 3 });
    expect(tools.has("agent")).toBe(false);
    expect(tools.has("qronos-agent")).toBe(false);
  });

  test("depth is read from the environment with a sane fallback", () => {
    expect(maxSubagentDepth({} as NodeJS.ProcessEnv)).toBe(DEFAULT_MAX_SUBAGENT_DEPTH);
    expect(maxSubagentDepth({ QRONOS_MAX_SUBAGENT_DEPTH: "1" } as any)).toBe(1);
    expect(maxSubagentDepth({ QRONOS_MAX_SUBAGENT_DEPTH: "0" } as any)).toBe(DEFAULT_MAX_SUBAGENT_DEPTH);
    expect(maxSubagentDepth({ QRONOS_MAX_SUBAGENT_DEPTH: "abc" } as any)).toBe(DEFAULT_MAX_SUBAGENT_DEPTH);
  });

  test("concurrency limit is read from the environment", () => {
    expect(maxConcurrentSubagents({} as NodeJS.ProcessEnv)).toBe(DEFAULT_MAX_CONCURRENT_SUBAGENTS);
    expect(maxConcurrentSubagents({ QRONOS_MAX_CONCURRENT_SUBAGENTS: "2" } as any)).toBe(2);
    expect(maxConcurrentSubagents({ QRONOS_MAX_CONCURRENT_SUBAGENTS: "-4" } as any)).toBe(
      DEFAULT_MAX_CONCURRENT_SUBAGENTS,
    );
  });
});

describe("subagent tools: empty result never leaves an agent useless", () => {
  test("denying everything falls back to the read-only floor", () => {
    const { tools } = resolve({ agentTools: ["bash"], parentCanWrite: false });
    expect(tools.size).toBeGreaterThan(0);
    // The floor is drawn from the parent's read-only tools only.
    for (const name of tools) expect(READ_ONLY_TOOLS.has(name)).toBe(true);
  });
});
