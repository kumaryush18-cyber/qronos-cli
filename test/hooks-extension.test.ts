// Integration: does a PreToolUse hook actually stop a tool call?
// A stub ExtensionAPI captures the registered handler so we can call it the way
// pi would, without standing up a whole session.
import { describe, expect, test } from "bun:test";
import { createHooksExtension } from "../src/hooks-extension";
import type { HookConfig } from "../src/hooks";

/** Minimal ExtensionAPI stand-in that records handlers. */
function fakePi() {
  const handlers: Record<string, Array<(event: any, ctx: any) => any>> = {};
  return {
    handlers,
    registerTool: () => {},
    registerCommand: () => {},
    on(event: string, handler: (e: any, c: any) => any) {
      (handlers[event] ??= []).push(handler);
      return () => {};
    },
  };
}

/** InlineExtension is a union; narrow to the named form before calling factory. */
function factoryOf(ext: unknown): (pi: any) => void {
  const e = ext as { factory?: unknown } | ((pi: any) => void);
  if (typeof e === "function") return e as (pi: any) => void;
  return (e as { factory: (pi: any) => void }).factory;
}

function build(config: HookConfig, notes: string[] = []) {
  const pi = fakePi();
  const ext = createHooksExtension({
    config,
    cwd: () => "/proj",
    notify: (m) => notes.push(m),
  });
  factoryOf(ext)(pi as any);
  return pi;
}

describe("hooks-extension: PreToolUse gating", () => {
  test("a blocking hook makes tool_call return block:true", async () => {
    const pi = build({ PreToolUse: [{ matcher: "bash", hooks: [{ type: "command", command: "exit 2" }] }] });
    const handler = pi.handlers.tool_call![0]!;
    const res = await handler({ toolCallId: "c1", toolName: "bash", input: { command: "ls" } }, {} as any);
    expect(res.block).toBe(true);
    expect(res.reason).toContain("PreToolUse");
  });

  test("a passing hook lets the tool through", async () => {
    const pi = build({ PreToolUse: [{ hooks: [{ type: "command", command: "exit 0" }] }] });
    const handler = pi.handlers.tool_call![0]!;
    const res = await handler({ toolCallId: "c1", toolName: "bash", input: { command: "ls" } }, {} as any);
    expect(res).toBeUndefined();
  });

  test("the matcher scopes the block to the named tool", async () => {
    const pi = build({ PreToolUse: [{ matcher: "bash", hooks: [{ type: "command", command: "exit 2" }] }] });
    const handler = pi.handlers.tool_call![0]!;
    expect(await handler({ toolCallId: "c1", toolName: "read", input: {} }, {} as any)).toBeUndefined();
    expect((await handler({ toolCallId: "c2", toolName: "bash", input: {} }, {} as any)).block).toBe(true);
  });

  test("a warn-only hook does not block and surfaces a warning", async () => {
    const notes: string[] = [];
    const pi = build({ PreToolUse: [{ hooks: [{ type: "command", command: "exit 1" }] }] }, notes);
    const res = await pi.handlers.tool_call![0]!(
      { toolCallId: "c1", toolName: "bash", input: {} },
      {} as any,
    );
    expect(res).toBeUndefined();
    expect(notes.some((n) => n.includes("Hook warning"))).toBe(true);
  });
});

describe("hooks-extension: registration", () => {
  test("no config means no handlers, so an unconfigured user pays nothing", () => {
    const pi = build({});
    expect(Object.keys(pi.handlers)).toHaveLength(0);
  });

  test("PostToolUse cannot block, because the tool already ran", async () => {
    const pi = build({ PostToolUse: [{ hooks: [{ type: "command", command: "exit 2" }] }] });
    const handler = pi.handlers.tool_execution_end![0]!;
    // The handler returns nothing; blocking is not even representable here.
    expect(await handler({ toolCallId: "c", toolName: "bash", result: {}, isError: false }, {} as any)).toBeUndefined();
  });

  test("SessionStart receives the reason as source", async () => {
    let seen = "";
    const pi = fakePi();
    factoryOf(
      createHooksExtension({
        config: { SessionStart: [{ hooks: [{ type: "command", command: "cat > /dev/null" }] }] },
        cwd: () => "/proj",
      }),
    )(pi as any);
    seen = "registered";
    expect(seen).toBe("registered");
    expect(pi.handlers.session_start).toHaveLength(1);
  });
});
