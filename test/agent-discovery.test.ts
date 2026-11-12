import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUILTIN_AGENTS,
  discoverSubagents,
  resolveSubagent,
} from "../src/agent-discovery";

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("discoverSubagents", () => {
  test("returns built-in agents when no custom files exist", () => {
    const projectRoot = makeTempDir("qronos-project-");
    const userHome = makeTempDir("qronos-home-");

    const agents = discoverSubagents(projectRoot, userHome);
    const names = agents.map((a) => a.name);

    expect(names).toContain("general-purpose");
    expect(names).toContain("Explore");
    expect(names).toContain("Plan");

    const general = agents.find((a) => a.name === "general-purpose")!;
    expect(general.source).toBe("builtin");
    expect(general.tools).toContain("read");
    expect(general.tools).toContain("exit_plan_mode");
  });

  test("discovers custom agents from user directory ~/.qronos/agents/*.md", () => {
    const projectRoot = makeTempDir("qronos-project-");
    const userHome = makeTempDir("qronos-home-");

    const agentsDir = join(userHome, ".qronos", "agents");
    mkdirSync(agentsDir, { recursive: true });

    writeFileSync(
      join(agentsDir, "security-auditor.md"),
      `---
name: security-auditor
description: Audits code for security vulnerabilities
tools: read, grep
---
You are a security auditor. Analyze code for vulnerabilities.`,
      "utf-8",
    );

    const agents = discoverSubagents(projectRoot, userHome);
    const custom = agents.find((a) => a.name === "security-auditor");

    expect(custom).toBeDefined();
    expect(custom?.source).toBe("user");
    expect(custom?.description).toBe("Audits code for security vulnerabilities");
    expect(custom?.tools).toEqual(["read", "grep"]);
    expect(custom?.systemPrompt).toContain("You are a security auditor");
  });

  test("project-level agents in <root>/.qronos/agents/*.md override user-level and built-in", () => {
    const projectRoot = makeTempDir("qronos-project-");
    const userHome = makeTempDir("qronos-home-");

    const projectAgentsDir = join(projectRoot, ".qronos", "agents");
    mkdirSync(projectAgentsDir, { recursive: true });

    writeFileSync(
      join(projectAgentsDir, "Plan.md"),
      `---
name: Plan
description: Custom project plan architect
tools: read, grep, exit_plan_mode
---
Custom project planning instructions.`,
      "utf-8",
    );

    const agents = discoverSubagents(projectRoot, userHome);
    const plan = agents.find((a) => a.name.toLowerCase() === "plan");

    expect(plan).toBeDefined();
    expect(plan?.source).toBe("project");
    expect(plan?.description).toBe("Custom project plan architect");
    expect(plan?.systemPrompt).toBe("Custom project planning instructions.");
  });

  test("resolveSubagent falls back to general-purpose for unknown types", () => {
    const projectRoot = makeTempDir("qronos-project-");
    const userHome = makeTempDir("qronos-home-");

    const resolved = resolveSubagent("non-existent-agent-type", projectRoot, userHome);
    expect(resolved.name).toBe("general-purpose");
    expect(resolved.source).toBe("builtin");
  });
});
