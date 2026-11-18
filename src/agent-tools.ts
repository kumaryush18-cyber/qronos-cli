// Subagent tool resolution — model of Claude Code's two-filter design, with a
// single added invariant that Claude Code does not enforce and we do:
//
// **A subagent can never be more permissive than its parent.**
//
// Claude Code's rule is "each subagent inherits the parent conversation's
// permission rules", applied through two filters:
//
// filter 1 ALWAYS_DENIED removed from every subagent, always
// filter 2 tool pool what the definition asks for, minus denials
//
// The previous design here instead pinned an absolute read-only list. That was
// stricter than Claude Code and it broke the plan flow: a subagent was handed
// `exit_plan_mode` but had no write tools, so an approval could never unblock
// anything. It also meant a write-capable parent could not delegate a write,
// which is the main reason to have subagents at all.
//
// Resolution order (each step can only ever remove tools):
// 1. deny-list first, exactly as documented ("disallowedTools is applied
// first, then tools is resolved against the remaining pool")
// 2. the definition's `tools` allow-list, if present
// 3. the parent session's pool — the inheritance step
// 4. plan-mode floor: if the parent is read-only, so is the subagent
// 5. ALWAYS_DENIED
// 6. the depth limit, which withholds the agent tool itself
//
// `bash` is not treated as read-only anywhere in this file: a shell can write,
// so it is gated by the same parent-mode check as `write` and `edit`.

/** Tools no subagent may hold, mirroring the documented first filter. */
export const SUBAGENT_ALWAYS_DENIED: ReadonlySet<string> = new Set([
  // A subagent must not be able to end the session or ask the user directly;
  // only the top-level agent owns the conversation.
  "ask_user_question",
  "ask_user",
  "end_conversation",
  "end_session",
  "schedule_wakeup",
  "wait_for_mcp_servers",
  "workflow",
  // Recursion is governed by the depth limit, not by tool availability.
  "agent",
  "qronos-agent",
]);

/**
 * Tools that can mutate the workspace. A subagent gets these only when the
 * parent session is itself in an editing mode.
 */
export const MUTATING_TOOLS: ReadonlySet<string> = new Set([
  "write",
  "edit",
  "multi_edit",
  "notebook_edit",
  "patch",
  "bash",
  "shell",
  "run_command",
]);

/** Tools that are safe regardless of permission mode. */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "read",
  "read_file",
  "grep",
  "glob",
  "find",
  "list_dir",
  "ls",
  "web_search",
  "docs_lookup",
  "qronos_docs",
  "qronos_usage",
  "todo",
]);

export interface ResolveToolsInput {
  /** Tools the definition declared, splitting on commas is the caller's job. */
  agentTools?: readonly string[];
  /** Tools the definition explicitly forbade. */
  disallowedTools?: readonly string[];
  /** Every tool the parent session currently holds. */
  parentTools: readonly string[];
  /** True when the parent is in an editing mode (not plan/read-only). */
  parentCanWrite: boolean;
  /** Nesting level of the subagent being spawned: 1 = spawned by the parent. */
  depth: number;
  /** Maximum nesting depth; at the limit the agent tool is withheld. */
  maxDepth: number;
}

export interface ResolveToolsResult {
  tools: Set<string>;
  /** Why each requested tool was dropped, for diagnostics and tests. */
  dropped: Record<string, string>;
}

/**
 * Resolve the exact tool set a subagent may use.
 *
 * Deterministic and side-effect free so the security properties can be pinned
 * by tests rather than reasoned about.
 */
export function resolveSubagentTools(input: ResolveToolsInput): ResolveToolsResult {
  const dropped: Record<string, string> = {};
  const deny = new Set((input.disallowedTools ?? []).map(lower));

  // Start from either the declared allow-list or the whole parent pool.
  // An empty allow-list is treated as absent, matching how a definition with no
  // `tools` field is meant to read.
  const declared = (input.agentTools ?? []).map(lower).filter(Boolean);
  const source = declared.length > 0 ? declared : input.parentTools.map(lower);

  const tools = new Set<string>();

  for (const name of source) {
    // 1. deny-list wins over everything.
    if (deny.has(name)) {
      dropped[name] = "listed in disallowedTools";
      continue;
    }
    // 2. inheritance: a subagent cannot hold a tool its parent lacks.
    if (!input.parentCanWrite && MUTATING_TOOLS.has(name)) {
      dropped[name] = "parent session is read-only";
      continue;
    }
    if (declared.length > 0 && !input.parentTools.map(lower).includes(name) && !READ_ONLY_TOOLS.has(name)) {
      dropped[name] = "not held by the parent session";
      continue;
    }
    // 3. the always-denied filter.
    if (SUBAGENT_ALWAYS_DENIED.has(name)) {
      dropped[name] = "denied for all subagents";
      continue;
    }
    tools.add(name);
  }

  // 4. depth limit withholds the agent tool, exactly as documented.
  if (input.depth > input.maxDepth) {
    dropped["agent"] = "subagent spawn depth limit reached";
    dropped["qronos-agent"] = "subagent spawn depth limit reached";
    tools.delete("agent");
    tools.delete("qronos-agent");
  }

  // 5. A subagent with no usable tools is useless; fall back to the read-only
  // floor so it can at least look around instead of failing to launch.
  if (tools.size === 0) {
    for (const name of READ_ONLY_TOOLS) {
      if (input.parentTools.map(lower).includes(name)) tools.add(name);
    }
  }

  return { tools, dropped };
}

function lower(s: string): string {
  return s.trim().toLowerCase();
}

export const DEFAULT_MAX_SUBAGENT_DEPTH = 3;

/** Read the depth cap from the environment, falling back to the default. */
export function maxSubagentDepth(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.QRONOS_MAX_SUBAGENT_DEPTH);
  if (!Number.isInteger(raw) || raw < 1) return DEFAULT_MAX_SUBAGENT_DEPTH;
  return raw;
}

/** Claude Code allows 20 concurrent subagents; we default lower. */
export const DEFAULT_MAX_CONCURRENT_SUBAGENTS = 8;

export function maxConcurrentSubagents(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.QRONOS_MAX_CONCURRENT_SUBAGENTS);
  if (!Number.isInteger(raw) || raw < 1) return DEFAULT_MAX_CONCURRENT_SUBAGENTS;
  return raw;
}
