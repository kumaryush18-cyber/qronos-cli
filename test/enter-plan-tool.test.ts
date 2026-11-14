import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createExitPlanToolExtension, ENTER_PLAN_TOOL_NAME, EXIT_PLAN_TOOL_NAME } from "../src/exit-plan-tool";
import { getExecutionMode, setExecutionMode } from "../src/execution-modes";

describe("enter_plan_mode tool", () => {
  function setup() {
    const tools: Record<string, any> = {};
    const pi = {
      registerTool: (tool: any) => {
        tools[tool.name] = tool;
      },
    } as unknown as ExtensionAPI;

    (createExitPlanToolExtension({}) as { factory: (p: ExtensionAPI) => void }).factory(pi);
    return tools;
  }

  test("enter_plan_mode is registered alongside exit_plan_mode", () => {
    const tools = setup();
    expect(tools[ENTER_PLAN_TOOL_NAME]).toBeDefined();
    expect(tools[EXIT_PLAN_TOOL_NAME]).toBeDefined();
    expect(tools[ENTER_PLAN_TOOL_NAME].label).toBe("Enter Plan Mode");
  });

  test("calling enter_plan_mode switches mode to plan and returns guidance", async () => {
    setExecutionMode("auto");
    expect(getExecutionMode()).toBe("auto");

    const tools = setup();
    const notifications: Array<{ msg: string; type?: string }> = [];
    const ctx = {
      ui: {
        notify: (msg: string, type?: string) => notifications.push({ msg, type }),
      },
    };

    const res = await tools[ENTER_PLAN_TOOL_NAME].execute(
      "id",
      { reason: "Multi-file authentication refactor" },
      undefined,
      undefined,
      ctx,
    );

    expect(getExecutionMode()).toBe("plan");
    expect(res.details.ok).toBe(true);
    expect(res.details.mode).toBe("plan");
    expect(res.content[0].text).toContain("Switched to Plan Mode");
    expect(res.content[0].text).toContain("Multi-file authentication refactor");
    expect(notifications[0]?.msg).toContain("Entered Plan Mode");

    // Calling again while already in plan mode informs the agent
    const res2 = await tools[ENTER_PLAN_TOOL_NAME].execute(
      "id2",
      { reason: "Another reason" },
      undefined,
      undefined,
      ctx,
    );
    expect(res2.content[0].text).toContain("Already in plan mode");
  });
});
