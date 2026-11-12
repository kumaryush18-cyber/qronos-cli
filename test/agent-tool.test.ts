import { describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import {
  AGENT_TOOL_NAME,
  createAgentToolExtension,
  defaultSubagentRunner,
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
