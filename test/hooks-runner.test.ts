// These spawn real shells: the point is that a hook's exit code actually
// reaches the tool_call decision, which a pure fake would not prove.
import { describe, expect, test } from "bun:test";
import { runEventHooks, runHookCommand } from "../src/hooks-runner";
import type { HookConfig, HookPayload } from "../src/hooks";

const payload: HookPayload = {
  hook_event_name: "PreToolUse",
  cwd: process.cwd(),
  tool_name: "bash",
  tool_input: { command: "ls" },
};

const cmd = (command: string, timeoutMs?: number) => ({
  type: "command" as const,
  command,
  ...(timeoutMs !== undefined ? { timeoutMs } : {}),
});

describe("hooks-runner: single command", () => {
  test("exit 0 allows", async () => {
    const r = await runHookCommand(cmd("exit 0"), payload);
    expect(r.outcome).toEqual({ kind: "allow" });
  });

  test("exit 2 blocks and the stderr text becomes the reason", async () => {
    const r = await runHookCommand(cmd("echo 'nope' >&2; exit 2"), payload);
    expect(r.outcome).toEqual({ kind: "block", reason: "nope" });
  });

  test("the payload really arrives on stdin", async () => {
    // The hook echoes stdin; we then assert the tool name round-tripped.
    const r = await runHookCommand(cmd("cat"), payload);
    expect(r.stdout).toContain('"tool_name":"bash"');
    expect(r.stdout).toContain('"hook_event_name":"PreToolUse"');
  });

  test("a hook that never exits is killed by its timeout", async () => {
    const r = await runHookCommand(cmd("sleep 10", 150), payload);
    // Timing out is a warning, never a block: a hung hook must not wedge tools.
    expect(r.outcome.kind).toBe("warn");
    expect(r.stderr).toContain("timed out");
  }, 5000);

  test("a command that cannot start warns instead of throwing", async () => {
    const r = await runHookCommand(cmd("/nonexistent/binary-xyz"), payload);
    expect(r.outcome.kind).toBe("warn");
  });

  test("stdout is bounded so a chatty hook cannot grow the heap", async () => {
    const r = await runHookCommand(cmd("yes A | head -c 200000"), payload);
    expect(r.stdout.length).toBeLessThanOrEqual(64_000);
  }, 10_000);
});

describe("hooks-runner: event fan-out", () => {
  test("runs every matching hook in order", async () => {
    const cfg: HookConfig = {
      PreToolUse: [
        { hooks: [cmd("exit 0")] },
        { matcher: "bash", hooks: [cmd("exit 0")] },
      ],
    };
    const res = await runEventHooks(cfg, "PreToolUse", payload);
    expect(res.results).toHaveLength(2);
    expect(res.blocked).toBeUndefined();
  });

  test("a blocking hook stops the chain at the blocker", async () => {
    const cfg: HookConfig = {
      PreToolUse: [
        { hooks: [cmd("exit 2")] },
        // Should never run: the first hook already blocked.
        { hooks: [cmd("exit 0")] },
      ],
    };
    const res = await runEventHooks(cfg, "PreToolUse", payload);
    expect(res.blocked).toBeDefined();
    expect(res.results).toHaveLength(1);
  });

  test("non-matching matchers do not run", async () => {
    const cfg: HookConfig = { PreToolUse: [{ matcher: "edit", hooks: [cmd("exit 2")] }] };
    const res = await runEventHooks(cfg, "PreToolUse", payload);
    expect(res.blocked).toBeUndefined();
    expect(res.results).toHaveLength(0);
  });

  test("a warning hook is collected but does not block", async () => {
    const cfg: HookConfig = { PreToolUse: [{ hooks: [cmd("exit 1")] }] };
    const res = await runEventHooks(cfg, "PreToolUse", payload);
    expect(res.blocked).toBeUndefined();
    expect(res.warnings).toHaveLength(1);
  });

  test("an empty config runs nothing", async () => {
    const res = await runEventHooks({}, "PreToolUse", payload);
    expect(res.results).toEqual([]);
  });
});
