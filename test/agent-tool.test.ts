import { describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import {
  AGENT_TOOL_NAME,
  createAgentToolExtension,
  defaultSubagentRunner,
  resolveSubagentToolNames,
  SUBAGENT_READ_ONLY_TOOLS,
} from "../src/agent-tool";

describe("createAgentToolExtension (Item ⑦: Subagents with Option B)", () => {
  test("registers agent tool with description, prompt, and subagent_type parameters", () => {
    let registeredTool: any = null;
    const fakePi = {
      registerTool: (tool: any) => {
        registeredTool = tool;
      },
    } as unknown as ExtensionAPI;

    const ext = createAgentToolExtension();
    expect(ext.name).toBe("qronos-agent");
    (ext as any).factory(fakePi);

    expect(registeredTool).not.toBeNull();
    expect(registeredTool.name).toBe(AGENT_TOOL_NAME);
    expect(registeredTool.parameters.properties.prompt).toBeDefined();
    expect(registeredTool.parameters.properties.description).toBeDefined();
    expect(registeredTool.parameters.properties.subagent_type).toBeDefined();
  });

  test("Option B: SUBAGENT_READ_ONLY_TOOLS strictly excludes mutating tools and agent recursion", () => {
    expect(SUBAGENT_READ_ONLY_TOOLS.has("read")).toBe(true);
    expect(SUBAGENT_READ_ONLY_TOOLS.has("grep")).toBe(true);
    expect(SUBAGENT_READ_ONLY_TOOLS.has("exit_plan_mode")).toBe(true);

    // Mutating tools must be forbidden
    expect(SUBAGENT_READ_ONLY_TOOLS.has("write")).toBe(false);
    expect(SUBAGENT_READ_ONLY_TOOLS.has("write_file")).toBe(false);
    expect(SUBAGENT_READ_ONLY_TOOLS.has("edit")).toBe(false);
    expect(SUBAGENT_READ_ONLY_TOOLS.has("edit_file")).toBe(false);
    // Recursion forbidden
    expect(SUBAGENT_READ_ONLY_TOOLS.has("agent")).toBe(false);
    expect(SUBAGENT_READ_ONLY_TOOLS.has("subagent")).toBe(false);
  });

  test("executes subagent with runner and returns formatted summary", async () => {
    let runnerCalled = false;
    const fakeRunner = async (params: any) => {
      runnerCalled = true;
      expect(params.prompt).toBe("Search for auth handlers");
      expect(params.description).toBe("Find auth code");
      return {
        output: "Found auth handlers in src/auth.ts:15",
        turns: 2,
        toolsUsed: ["read", "grep"],
        planApproved: false,
      };
    };

    let registeredTool: any = null;
    const fakePi = {
      registerTool: (tool: any) => {
        registeredTool = tool;
      },
    } as unknown as ExtensionAPI;

    const ext = createAgentToolExtension({ runner: fakeRunner });
    (ext as any).factory(fakePi);

    const fakeCtx = {
      cwd: "/test/project",
      ui: { notify: () => {} },
    } as unknown as ExtensionToolContext;

    const result = await registeredTool.execute(
      "call-1",
      {
        description: "Find auth code",
        prompt: "Search for auth handlers",
        subagent_type: "Explore",
      },
      undefined,
      undefined,
      fakeCtx,
    );

    expect(runnerCalled).toBe(true);
    expect(result.content[0].text).toContain("Subagent [Explore] completed task");
    expect(result.content[0].text).toContain("Found auth handlers in src/auth.ts:15");
    expect(result.details.ok).toBe(true);
    expect(result.details.turns).toBe(2);
    expect(result.details.toolsUsed).toEqual(["read", "grep"]);
  });

  test("handles plan approval reflection in subagent results", async () => {
    const fakeRunner = async () => ({
      output: "Created implementation plan.",
      turns: 3,
      toolsUsed: ["read", "exit_plan_mode"],
      planApproved: true,
    });

    let registeredTool: any = null;
    const fakePi = {
      registerTool: (tool: any) => {
        registeredTool = tool;
      },
    } as unknown as ExtensionAPI;

    const ext = createAgentToolExtension({ runner: fakeRunner });
    (ext as any).factory(fakePi);

    const fakeCtx = {
      cwd: "/test/project",
      ui: { notify: () => {} },
    } as unknown as ExtensionToolContext;

    const result = await registeredTool.execute(
      "call-2",
      {
        description: "Draft architecture plan",
        prompt: "Plan the new feature",
        subagent_type: "Plan",
      },
      undefined,
      undefined,
      fakeCtx,
    );

    expect(result.content[0].text).toContain("Plan: Approved ✓");
    expect(result.details.planApproved).toBe(true);
  });
});

describe("Option B: custom agent definitions cannot escalate privileges", () => {
  // Regression for a real hole: a definition's `tools:` list used to REPLACE
  // the read-only default, so `tools: write, edit, bash` in
  // .qronos/agents/*.md granted a subagent full write access.
  function agentWithTools(tools: string[] | undefined) {
    return {
      name: "x",
      description: "x",
      tools,
      systemPrompt: "",
      source: "project" as const,
    };
  }

  test("write/edit/bash are stripped from a definition that asks for them", () => {
    const allowed = resolveSubagentToolNames(agentWithTools(["write", "edit", "bash", "read"]));
    expect(allowed.has("write")).toBe(false);
    expect(allowed.has("edit")).toBe(false);
    expect(allowed.has("bash")).toBe(false);
    expect(allowed.has("read")).toBe(true);
  });

  test("a definition asking ONLY for forbidden tools falls back to the read-only set", () => {
    const allowed = resolveSubagentToolNames(agentWithTools(["write", "edit"]));
    expect(allowed.size).toBeGreaterThan(0);
    expect(allowed.has("write")).toBe(false);
    expect(allowed.has("read")).toBe(true);
  });

  test("no forbidden tool is ever reachable, for any definition shape", () => {
    const forbidden = ["write", "write_file", "edit", "edit_file", "bash", "agent", "subagent"];
    for (const tools of [undefined, [], forbidden, ["read", "write"], ["bash"]]) {
      const allowed = resolveSubagentToolNames(agentWithTools(tools as string[] | undefined));
      for (const f of forbidden) expect(allowed.has(f)).toBe(false);
    }
  });

  test("recursion is removed even if a definition asks for the agent tool", () => {
    const allowed = resolveSubagentToolNames(agentWithTools(["agent", "subagent", "read"]));
    expect(allowed.has("agent")).toBe(false);
    expect(allowed.has("subagent")).toBe(false);
  });

  test("a definition may still narrow the set to a read-only subset", () => {
    const allowed = resolveSubagentToolNames(agentWithTools(["grep", "read"]));
    expect([...allowed].sort()).toEqual(["grep", "read"]);
  });
});
