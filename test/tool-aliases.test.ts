import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  STEP_GUIDELINE,
  STEP_PARAM_DESCRIPTION,
  aliasArgs,
  createToolAliasesExtension,
  normalizeShellPath,
  shellParameters,
  withStepGuideline,
} from "../src/tool-aliases";

describe("tool argument aliases", () => {
  const bash = (a: unknown) => aliasArgs(a, "command", ["cmd"]);
  const read = (a: unknown) => aliasArgs(a, "path", ["file", "file_path"]);

  test("bash: cmd becomes command", () => {
    expect(bash({ cmd: "ls" })).toEqual({ command: "ls" });
  });
  test("bash: an existing command wins and is untouched", () => {
    const a = { command: "a", cmd: "b" };
    expect(bash(a)).toBe(a);
  });
  test("unrelated keys are untouched", () => {
    expect(bash({ cmd: "ls", timeout: 5 })).toEqual({ command: "ls", timeout: 5 });
    const a = { timeout: 5 };
    expect(bash(a)).toBe(a);
  });
  test("read: file and file_path become path", () => {
    expect(read({ file: "a" })).toEqual({ path: "a" });
    expect(read({ file_path: "a", limit: 3 })).toEqual({ path: "a", limit: 3 });
  });
  test("non-objects pass through", () => {
    expect(bash(undefined)).toBeUndefined();
  });
});

describe("session settings reach the re-registered tools", () => {
  function register(settings: Record<string, unknown>) {
    const tools: Record<string, any> = {};
    let calls = 0;
    const pi = {
      registerTool: (t: any) => (tools[t.name] = t),
      getSettings: () => {
        calls++;
        return settings;
      },
    };
    (createToolAliasesExtension() as { factory: (p: never) => void }).factory(pi as never);
    return { tools, calls: () => calls };
  }

  test("settings are read at call time, not in the factory", async () => {
    const { tools, calls } = register({ shellCommandPrefix: "echo PFX_MARK" });
    expect(calls()).toBe(0);
    const res = await tools.bash.execute("id", { command: "echo body" }, undefined, undefined, {
      cwd: process.cwd(),
      model: undefined,
      sessionManager: { getSessionId: () => "s", getSessionFile: () => undefined },
    });
    expect(calls()).toBeGreaterThan(0);
    const text = JSON.stringify(res.content);
    expect(text).toContain("PFX_MARK");
    expect(text).toContain("body");
  });
});

describe("normalizeShellPath (mirrors pi's normalizePath for shellPath)", () => {
  test("expands ~ and ~/x", () => {
    expect(normalizeShellPath("~", "linux", "/home/u")).toBe("/home/u");
    expect(normalizeShellPath("~/x", "linux", "/home/u")).toBe(join("/home/u", "x"));
  });
  test("file:// URLs become paths", () => {
    // A URL built from a real absolute path, so the case also holds on Windows.
    const abs = join(tmpdir(), "bash");
    expect(normalizeShellPath(pathToFileURL(abs).href, process.platform, "/h")).toBe(abs);
  });
  test("win32 converts Git Bash, WSL and Cygwin drive paths", () => {
    expect(normalizeShellPath("/c/Program Files/Git/bin/bash.exe", "win32", "C:\\h")).toBe(
      "C:\\Program Files\\Git\\bin\\bash.exe",
    );
    expect(normalizeShellPath("/mnt/d/x", "win32", "C:\\h")).toBe("D:\\x");
    expect(normalizeShellPath("/cygdrive/e", "win32", "C:\\h")).toBe("E:\\");
  });
  test("win32 leaves UNC and backslash paths alone; other platforms keep drive-looking paths", () => {
    expect(normalizeShellPath("//server/share", "win32", "C:\\h")).toBe("//server/share");
    expect(normalizeShellPath("/c/x", "linux", "/h")).toBe("/c/x");
  });
  test("win32 expands ~\\", () => {
    expect(normalizeShellPath("~\\x", "win32", "C:\\h")).toBe(join("C:\\h", "x"));
  });
});

describe("the optional step name (Claude Code parity)", () => {
  function registeredTools() {
    const tools: Record<string, any> = {};
    const pi = { registerTool: (t: any) => (tools[t.name] = t), getSettings: () => ({}) };
    (createToolAliasesExtension() as { factory: (p: never) => void }).factory(pi as never);
    return tools;
  }

  test("on: command, description and timeout, and only command is required", () => {
    const schema = shellParameters(true) as { properties: Record<string, { description?: string }>; required?: string[] };
    expect(Object.keys(schema.properties).sort()).toEqual(["command", "description", "timeout"]);
    expect(schema.properties.description!.description).toBe(STEP_PARAM_DESCRIPTION);
    expect(schema.required).toEqual(["command"]);
  });
  test("off: pi's own schema, so the model is not asked for the field", () => {
    const schema = shellParameters(false) as { properties: Record<string, unknown> };
    expect(Object.keys(schema.properties).sort()).toEqual(["command", "timeout"]);
  });
  test("the guideline is added, never replacing pi's own", () => {
    expect(withStepGuideline(["pi's own"], true)).toEqual(["pi's own", STEP_GUIDELINE]);
    expect(withStepGuideline(["pi's own"], false)).toEqual(["pi's own"]);
    expect(withStepGuideline(undefined, true)).toEqual([STEP_GUIDELINE]);
    expect(withStepGuideline(undefined, false)).toEqual([]);
  });
  test("the registered bash tool carries the field, and the alias still works", () => {
    const tools = registeredTools();
    const schema = tools.bash.parameters as { properties: Record<string, unknown> };
    expect(Object.keys(schema.properties)).toContain("description");
    expect(tools.bash.promptGuidelines).toContain(STEP_GUIDELINE);
    expect(tools.bash.prepareArguments({ cmd: "ls" })).toEqual({ command: "ls" });
  });
  test("QRONOS_TOOL_DESCRIPTIONS=0 removes the field from the schema", () => {
    const before = process.env.QRONOS_TOOL_DESCRIPTIONS;
    process.env.QRONOS_TOOL_DESCRIPTIONS = "0";
    try {
      const tools = registeredTools();
      const schema = tools.bash.parameters as { properties: Record<string, unknown> };
      expect(Object.keys(schema.properties).sort()).toEqual(["command", "timeout"]);
      expect(tools.bash.promptGuidelines).not.toContain(STEP_GUIDELINE);
    } finally {
      if (before === undefined) delete process.env.QRONOS_TOOL_DESCRIPTIONS;
      else process.env.QRONOS_TOOL_DESCRIPTIONS = before;
    }
  });
  test("no powershell tool on a platform that has none", () => {
    const tools = registeredTools();
    expect(tools.powershell).toBeUndefined();
  });
});
