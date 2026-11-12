// Lifecycle hooks, Claude-Code style: user commands run around tool calls and
// session events, with JSON on stdin and a nonzero exit able to block a tool.
//
// Design notes:
//   - Config is parsed and validated into a plain HookConfig; nothing here
//     touches the filesystem or spawns a process, so the matching rules and the
//     parsing are unit-testable on their own (see hooks.test.ts).
//   - A hook is a map from event -> array of matchers. Each matcher may carry
//     `matcher` (a regex on the tool name) and `hooks` (the commands).
//   - Matching is deliberately safe on bad input: an invalid regex is treated
//     as "matches nothing" rather than throwing mid-tool-call.

export const HOOK_EVENTS = ["PreToolUse", "PostToolUse", "SessionStart", "UserPromptSubmit", "Stop"] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

export function isHookEvent(value: string): value is HookEvent {
  return (HOOK_EVENTS as readonly string[]).includes(value);
}

/** One command to run for a matched event. */
export interface HookCommand {
  type: "command";
  command: string;
  /** Milliseconds before the hook is killed. Default 30000. */
  timeoutMs?: number;
}

/** One matcher block, e.g. { matcher: "edit|write", hooks: [...] }. */
export interface HookMatcher {
  /** Regex tested against the tool name. Absent or "*" means every tool. */
  matcher?: string;
  hooks: HookCommand[];
}

export type HookConfig = Partial<Record<HookEvent, HookMatcher[]>>;

export const DEFAULT_HOOK_TIMEOUT_MS = 30_000;

/**
 * Parse the `hooks` key of a settings file. Unknown events, entries without a
 * command, and malformed shapes are dropped rather than rejected whole, so one
 * bad entry cannot disable every other hook — the same forgiving contract
 * Claude Code uses. Returns an empty config when nothing is usable.
 */
export function parseHookConfig(raw: unknown): HookConfig {
  const out: HookConfig = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [event, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isHookEvent(event)) continue;
    if (!Array.isArray(value)) continue;
    const matchers: HookMatcher[] = [];
    for (const entry of value) {
      if (!entry || typeof entry !== "object") continue;
      const { matcher, hooks } = entry as { matcher?: unknown; hooks?: unknown };
      if (!Array.isArray(hooks)) continue;
      const commands: HookCommand[] = [];
      for (const h of hooks) {
        if (!h || typeof h !== "object") continue;
        const { type, command, timeoutMs } = h as { type?: unknown; command?: unknown; timeoutMs?: unknown };
        // Only "command" hooks are supported. Anything else is skipped so a
        // future hook type in a shared config cannot be misread as a command.
        if (type !== "command" || typeof command !== "string" || command.trim() === "") continue;
        const cmd: HookCommand = { type: "command", command: command.trim() };
        if (typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0) {
          cmd.timeoutMs = timeoutMs;
        }
        commands.push(cmd);
      }
      if (commands.length === 0) continue;
      const m: HookMatcher = { hooks: commands };
      if (typeof matcher === "string" && matcher.trim() !== "") m.matcher = matcher.trim();
      matchers.push(m);
    }
    if (matchers.length > 0) out[event] = matchers;
  }
  return out;
}

/** True when the matcher applies to this tool name. */
export function matcherApplies(matcher: string | undefined, toolName: string | undefined): boolean {
  if (!matcher || matcher === "*") return true;
  // Tool-name matchers only make sense for tool events; for session events the
  // caller passes no toolName and we treat a named matcher as non-matching.
  if (toolName === undefined) return matcher === "*";
  try {
    return new RegExp(matcher).test(toolName);
  } catch {
    // An invalid regex must never match: a typo would otherwise fire hooks on
    // unrelated tools, which is worse than silently not firing.
    return false;
  }
}

/** Every command that should run for an event (and optional tool). */
export function commandsFor(config: HookConfig, event: HookEvent, toolName?: string): HookCommand[] {
  const matchers = config[event];
  if (!matchers) return [];
  const out: HookCommand[] = [];
  for (const m of matchers) {
    if (matcherApplies(m.matcher, toolName)) out.push(...m.hooks);
  }
  return out;
}

/** The JSON written to a hook's stdin. Shaped like Claude Code's payload. */
export interface HookPayload {
  hook_event_name: HookEvent;
  cwd: string;
  session_id?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_result?: unknown;
  /** Populated for PostToolUse. */
  tool_error?: boolean;
  /** The user's prompt, for UserPromptSubmit. */
  prompt?: string;
  /** Why the session started (SessionStart). */
  source?: string;
}

/**
 * Classify a hook's result.
 *
 * Convention: exit 0 allows, exit 2 blocks (with stderr as the reason), any
 * other nonzero exit is a non-blocking error that is surfaced as a warning.
 * That mirrors Claude Code, where 2 is the "deliberately blocking" code and
 * other failures are noise rather than a veto.
 */
export type HookOutcome =
  | { kind: "allow" }
  | { kind: "block"; reason: string }
  | { kind: "warn"; message: string };

export function classifyHookResult(exitCode: number, stdout: string, stderr: string): HookOutcome {
  if (exitCode === 0) {
    // Claude Code also allows JSON on stdout with a decision field; support the
    // common shapes so an existing hook keeps working.
    const json = tryParseHookJson(stdout);
    if (json?.decision === "block" || json?.decision === "deny") {
      return { kind: "block", reason: json.reason || "blocked by hook" };
    }
    return { kind: "allow" };
  }
  if (exitCode === 2) {
    const reason = stderr.trim() || stdout.trim() || "blocked by hook";
    return { kind: "block", reason };
  }
  return { kind: "warn", message: stderr.trim() || `hook exited with code ${exitCode}` };
}

function tryParseHookJson(stdout: string): { decision?: string; reason?: string } | undefined {
  const text = stdout.trim();
  if (!text.startsWith("{")) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object") return parsed as { decision?: string; reason?: string };
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Concatenate two hook configs, later entries running after earlier ones.
 * User-level hooks run first so a project hook can see what the user decided,
 * and neither source silently discards the other's hooks for an event.
 */
export function mergeHookConfigs(base: HookConfig, extra: HookConfig): HookConfig {
  const out: HookConfig = {};
  for (const event of HOOK_EVENTS) {
    const a = base[event];
    const b = extra[event];
    if (!a && !b) continue;
    out[event] = [...(a ?? []), ...(b ?? [])];
  }
  return out;
}
