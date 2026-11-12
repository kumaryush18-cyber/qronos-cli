// Executes hook commands. Split from hooks.ts so the matching/parsing rules
// stay pure; this half owns spawning, stdin, timeouts and the shell.
//
// Every failure mode is non-fatal by design: a hook that times out, cannot be
// spawned, or writes garbage is reported as a warning and the tool call
// proceeds. The only way a hook stops the agent is exit code 2 (or an explicit
// {"decision":"block"} on stdout), so a broken hook can never wedge a session.
import { spawn } from "node:child_process";
import {
  classifyHookResult,
  commandsFor,
  DEFAULT_HOOK_TIMEOUT_MS,
  type HookCommand,
  type HookConfig,
  type HookEvent,
  type HookOutcome,
  type HookPayload,
} from "./hooks";

export interface RunHookResult {
  command: string;
  outcome: HookOutcome;
  stdout: string;
  stderr: string;
}

/** Cap on captured stdout/stderr per hook, so a chatty hook cannot grow the heap. */
export const MAX_CAPTURE_BYTES = 64_000;

export interface HookRunnerDeps {
  /** Injected in tests; defaults to node:child_process spawn. */
  spawnImpl?: typeof spawn;
  /** Environment for hook processes. */
  env?: NodeJS.ProcessEnv;
}

/** Run one command with `payload` on stdin, killing it after its timeout. */
export function runHookCommand(
  cmd: HookCommand,
  payload: HookPayload,
  deps: HookRunnerDeps = {},
): Promise<RunHookResult> {
  const doSpawn = deps.spawnImpl ?? spawn;
  const timeoutMs = cmd.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;

  return new Promise<RunHookResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (exitCode: number, note?: string) => {
      if (settled) return;
      settled = true;
      if (note) stderr = `${stderr}${stderr ? "\n" : ""}${note}`;
      resolve({
        command: cmd.command,
        outcome: classifyHookResult(exitCode, stdout, stderr),
        stdout,
        stderr,
      });
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = doSpawn(cmd.command, {
        shell: true,
        env: deps.env ?? process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      // A command that cannot even be spawned is a warning, not a block.
      finish(1, `could not start hook: ${(err as Error).message}`);
      return;
    }

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
      finish(1, `hook timed out after ${timeoutMs}ms`);
    }, timeoutMs);
    timer.unref?.();

    child.stdout?.on("data", (d: Buffer) => {
      // Bound the buffer: a hook that prints megabytes must not grow our heap.
      if (stdout.length < MAX_CAPTURE_BYTES) stdout += d.toString().slice(0, MAX_CAPTURE_BYTES - stdout.length);
    });
    child.stderr?.on("data", (d: Buffer) => {
      if (stderr.length < MAX_CAPTURE_BYTES) stderr += d.toString().slice(0, MAX_CAPTURE_BYTES - stderr.length);
    });
    child.on("error", (err: Error) => {
      clearTimeout(timer);
      finish(1, `hook error: ${err.message}`);
    });
    child.on("close", (code: number | null) => {
      clearTimeout(timer);
      finish(code ?? 1);
    });

    try {
      // A hook like `exit 0` closes its stdin immediately, so the write can
      // fail with EPIPE. That is normal, not an error: attach a no-op handler so
      // the stream error cannot surface as an uncaught exception.
      child.stdin?.on("error", () => {});
      child.stdin?.end(`${JSON.stringify(payload)}\n`);
    } catch {
      // If stdin is unavailable the hook still runs; it just sees no payload.
    }
  });
}

export interface RunEventHooksResult {
  /** First blocking outcome, if any. */
  blocked?: { command: string; reason: string };
  warnings: string[];
  results: RunHookResult[];
}

/**
 * Run every hook for an event. Stops at the first block (later hooks for a
 * blocked tool would be pointless and could have side effects).
 */
export async function runEventHooks(
  config: HookConfig,
  event: HookEvent,
  payload: HookPayload,
  deps: HookRunnerDeps = {},
): Promise<RunEventHooksResult> {
  const commands = commandsFor(config, event, payload.tool_name);
  const warnings: string[] = [];
  const results: RunHookResult[] = [];

  for (const cmd of commands) {
    const result = await runHookCommand(cmd, payload, deps);
    results.push(result);
    if (result.outcome.kind === "block") {
      return { blocked: { command: cmd.command, reason: result.outcome.reason }, warnings, results };
    }
    if (result.outcome.kind === "warn") warnings.push(`${cmd.command}: ${result.outcome.message}`);
  }
  return { warnings, results };
}
