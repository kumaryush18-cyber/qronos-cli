import { truncateToWidth } from "@earendil-works/pi-tui";
import { isDestructiveCommand } from "./tool-guard";

export type ExecutionMode =
  | "auto"
  | "edit-automatically"
  | "plan"
  | "manual"
  | "dangerously-skip-permissions";

const CYCLE_ORDER: ExecutionMode[] = ["auto", "edit-automatically", "plan", "manual"];

let currentMode: ExecutionMode = "auto";
let initialDangerFlag = false;

export function initExecutionMode(dangerouslySkipPermissions?: boolean): void {
  if (dangerouslySkipPermissions) {
    initialDangerFlag = true;
    currentMode = "dangerously-skip-permissions";
  } else {
    currentMode = "auto";
  }
}

export function getExecutionMode(): ExecutionMode {
  return currentMode;
}

export function setExecutionMode(mode: ExecutionMode): void {
  currentMode = mode;
}

export function cycleExecutionMode(): ExecutionMode {
  if (currentMode === "dangerously-skip-permissions") {
    currentMode = "auto";
    return currentMode;
  }
  const idx = CYCLE_ORDER.indexOf(currentMode);
  const nextIdx = (idx + 1) % CYCLE_ORDER.length;
  currentMode = CYCLE_ORDER[nextIdx] ?? "auto";
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
  "free_pi_docs",
  "free_pi_usage",
  "free_pi_buy_credits",
  "todo",
  "tool_search",
]);

const WRITE_TOOLS = new Set(["write", "write_file", "edit", "edit_file"]);

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
      if (cmd && !/^(ls|pwd|cat|head|tail|git status|git diff|git log|find|grep|echo)\b/i.test(cmd)) {
        return {
          block: true,
          reason:
            `Command blocked in Plan Mode: "${cmd}". Press Shift+Tab to switch modes to run modifying commands.`,
        };
      }
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
