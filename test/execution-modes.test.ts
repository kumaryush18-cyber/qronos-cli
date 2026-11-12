import { describe, expect, test } from "bun:test";
import {
  checkToolExecutionPermission,
  cycleExecutionMode,
  getExecutionMode,
  getExecutionModeStatusLine,
  initExecutionMode,
  setExecutionMode,
} from "../src/execution-modes";

describe("execution-modes", () => {
  test("initializes to auto by default, or dangerously-skip-permissions if flag passed", () => {
    initExecutionMode(false);
    expect(getExecutionMode()).toBe("auto");

    initExecutionMode(true);
    expect(getExecutionMode()).toBe("dangerously-skip-permissions");
  });

  test("Shift+Tab cycle order: auto -> edit-automatically -> plan -> manual -> auto", () => {
    setExecutionMode("auto");
    expect(cycleExecutionMode()).toBe("edit-automatically");
    expect(cycleExecutionMode()).toBe("plan");
    expect(cycleExecutionMode()).toBe("manual");
    expect(cycleExecutionMode()).toBe("auto");
  });

  test("getExecutionModeStatusLine formats colored indicators safely under terminal width", () => {
    for (const mode of ["auto", "edit-automatically", "plan", "manual", "dangerously-skip-permissions"] as const) {
      setExecutionMode(mode);
      for (const w of [40, 56, 80]) {
        const line = getExecutionModeStatusLine(w);
        expect(line.length).toBeGreaterThan(0);
      }
    }
  });

  test("Plan mode blocks mutating tools and allows read tools", async () => {
    setExecutionMode("plan");
    let confirmCalled = false;
    const confirmFn = async () => {
      confirmCalled = true;
      return true;
    };

    // Read tool allowed in plan mode
    const readCheck = await checkToolExecutionPermission("read", { file_path: "foo.txt" }, confirmFn);
    expect(readCheck.block).toBe(false);
    expect(confirmCalled).toBe(false);

    // Write tool blocked in plan mode
    const writeCheck = await checkToolExecutionPermission("write", { file_path: "foo.txt", content: "x" }, confirmFn);
    expect(writeCheck.block).toBe(true);
    expect(writeCheck.reason).toContain("Plan Mode");
  });

  test("Edit automatically permits writes automatically, prompts for bash", async () => {
    setExecutionMode("edit-automatically");
    let confirmCalled = false;
    const confirmFn = async () => {
      confirmCalled = true;
      return true;
    };

    // Write tool auto-approved
    const writeCheck = await checkToolExecutionPermission("write", { file_path: "foo.txt", content: "x" }, confirmFn);
    expect(writeCheck.block).toBe(false);
    expect(confirmCalled).toBe(false);

    // Bash prompts confirmation
    const bashCheck = await checkToolExecutionPermission("bash", { command: "npm test" }, confirmFn);
    expect(bashCheck.block).toBe(false);
    expect(confirmCalled).toBe(true);
  });

  test("Manual mode prompts for file edits and blocks if user declines", async () => {
    setExecutionMode("manual");
    let confirmResult = false;
    const confirmFn = async () => confirmResult;

    // User declines
    const writeCheck = await checkToolExecutionPermission("write", { file_path: "foo.txt" }, confirmFn);
    expect(writeCheck.block).toBe(true);

    // User confirms
    confirmResult = true;
    const writeCheck2 = await checkToolExecutionPermission("write", { file_path: "foo.txt" }, confirmFn);
    expect(writeCheck2.block).toBe(false);
  });

  test("Dangerously skip permissions bypasses all prompts", async () => {
    setExecutionMode("dangerously-skip-permissions");
    let confirmCalled = false;
    const confirmFn = async () => {
      confirmCalled = true;
      return true;
    };

    const res = await checkToolExecutionPermission("write", { file_path: "foo.txt" }, confirmFn);
    expect(res.block).toBe(false);
    expect(confirmCalled).toBe(false);
  });
});
