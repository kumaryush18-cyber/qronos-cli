// When a workflow subagent may use a tool without asking.
//
// Why this exists: a workflow can start sixteen agents that read, write and run
// shell commands in your project. Before this file, a subagent used any tool it
// held, with no question at all — the one place in the CLI where the chat's
// permission mode did not apply. Claude Code asks inside a workflow, and so do we.
//
// The rule is not new and not invented here: it is the chat's own rule, written
// again because the chat asks with a dialog and a workflow asks with a card:
//
//   dangerously skip permissions  nothing asks, ever
//   plan                          reads only; a write or a shell command is refused
//   edit-automatically            writes run, shell commands ask
//   auto (the default)            writes and normal shell commands run; a
//                                 destructive command asks
//   manual                        everything but a read asks
//
// Two rules on top:
//
//   1. "Allow for this run" is a grant that lives on the run and dies with it.
//      Nothing is written to disk, so a choice made in one run cannot quietly
//      follow you into the next one.
//   2. Nothing here reads the clock, the disk or the terminal. This module
//      decides; workflow-tool-approval.ts asks. That is what makes the decision
//      testable without a UI.
import type { ExecutionMode } from "./execution-modes";
import { isDestructiveCommand } from "./tool-guard";

/** What a tool would do, in the few words a card needs. */
export type ToolKind = "read" | "write" | "shell" | "other";

export interface ToolRequest {
  /** The tool's name, as the model wrote it. */
  name: string;
  args: Record<string, unknown>;
  /** Where the project is, so a path outside it can be spotted. */
  cwd: string;
}

export interface ToolFacts {
  kind: ToolKind;
  /** The project-relative path for a write, when one can be read. */
  path?: string;
  /** The command for a shell tool. */
  command?: string;
  /** False when a write points outside the project. */
  insideProject: boolean;
  /** True for a command that can destroy work (`rm -rf`, `git reset --hard`). */
  dangerous: boolean;
  /** The one-line description a card shows. */
  summary: string;
}

/** What to do with one tool call. */
export type ToolVerdict = "allow" | "ask" | "refuse";

const READ_TOOLS = new Set([
  "read",
  "read_file",
  "grep",
  "glob",
  "find",
  "search",
  "web_search",
  "docs_lookup",
  "ls",
  "list_dir",
  "directory_list",
  "lsp",
  "todo",
]);

const WRITE_TOOLS = new Set(["write", "write_file", "edit", "edit_file", "apply_patch", "multi_edit", "notebook_edit"]);

const SHELL_TOOLS = new Set(["bash", "shell", "run_terminal_cmd", "exec"]);

const NETWORK_TOOLS = new Set(["web_fetch", "fetch", "curl", "http_request", "generate_image"]);

/** Commands that only look, so `plan` mode and the card can say so. */
const READ_ONLY_COMMAND =
  /^(ls|cat|head|tail|wc|grep|find|rg|pwd|echo|which|stat|file|tree|git\s+(status|log|show|diff|branch|remote|rev-parse|ls-files)|node\s+--version|npm\s+ls|bun\s+--version|tsc\s+--noEmit)\b/;

/** Shell operators that make a "read-only" command not read-only. */
const SHELL_OPERATOR = /[;&|<>`$()]/;

/** A command with no shell operators, but only reading. */
export function isReadOnlyCommand(command: string): boolean {
  const text = String(command ?? "").trim();
  if (text === "") return false;
  if (SHELL_OPERATOR.test(text)) return false;
  return READ_ONLY_COMMAND.test(text);
}

/** The first path-looking argument of a tool call. */
export function pathFromArgs(args: Record<string, unknown>): string | undefined {
  for (const key of ["path", "file_path", "filePath", "filename", "file", "target"]) {
    const value = args?.[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return undefined;
}

/** The command of a shell tool call. */
export function commandFromArgs(args: Record<string, unknown>): string | undefined {
  for (const key of ["command", "cmd", "script"]) {
    const value = args?.[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return undefined;
}

/** True when `path` stays inside `cwd`. Pure string work, no disk read. */
export function isInsideProject(path: string, cwd: string): boolean {
  const clean = path.replace(/\\/g, "/").trim();
  if (clean === "") return true;
  // An absolute path must start with the project, and an absolute-looking path
  // with no project to compare against is not inside it.
  const isAbsolute = clean.startsWith("/") || /^[a-zA-Z]:\//.test(clean);
  if (isAbsolute) {
    const root = String(cwd ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
    if (root === "") return false;
    return clean === root || clean.startsWith(`${root}/`);
  }
  // A relative path climbs out with `..`, and a `~` is somebody's home.
  if (clean.startsWith("~")) return false;
  const parts: string[] = [];
  for (const part of clean.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return false;
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return true;
}

/** Read one tool call into the few facts a decision needs. */
export function readToolFacts(request: ToolRequest): ToolFacts {
  const name = String(request?.name ?? "").toLowerCase();
  const args = (request?.args ?? {}) as Record<string, unknown>;
  const cwd = String(request?.cwd ?? "");
  const path = pathFromArgs(args);
  const command = commandFromArgs(args);
  const insideProject = path === undefined ? true : isInsideProject(path, cwd);

  if (SHELL_TOOLS.has(name)) {
    const cmd = command ?? "";
    const dangerous = isDestructiveCommand(cmd);
    return {
      kind: "shell",
      command: cmd,
      path,
      insideProject,
      dangerous,
      summary: cmd === "" ? "run a shell command" : `run: ${oneLine(cmd)}`,
    };
  }
  if (WRITE_TOOLS.has(name)) {
    return {
      kind: "write",
      path,
      insideProject,
      dangerous: !insideProject,
      summary: path ? `write ${path}${insideProject ? "" : " (outside the project)"}` : "write a file",
    };
  }
  if (READ_TOOLS.has(name)) {
    return {
      kind: "read",
      path,
      insideProject,
      dangerous: false,
      summary: path ? `read ${path}` : `use ${name}`,
    };
  }
  if (NETWORK_TOOLS.has(name)) {
    const url = typeof args?.url === "string" ? args.url : typeof args?.query === "string" ? args.query : "";
    return {
      kind: "other",
      path,
      insideProject,
      dangerous: true,
      summary: url === "" ? `use ${name}` : `${name}: ${oneLine(url)}`,
    };
  }
  return {
    kind: "other",
    path,
    insideProject,
    dangerous: false,
    summary: path ? `use ${name} on ${path}` : `use ${name}`,
  };
}

/** One line, whitespace collapsed, so a card row is always one row. */
export function oneLine(text: string): string {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

/**
 * The keys a grant is stored under.
 *
 * Two shapes, and only two: the whole tool (`all:bash`), or one tool under one
 * directory of the project (`path:write:src`). More shapes would mean a grant
 * that is hard to explain at the moment it is given.
 */
export function grantKeys(facts: ToolFacts): string[] {
  const tool = toolKey(facts);
  const keys = [`all:${tool}`];
  const dir = facts.path ? projectDir(facts.path) : undefined;
  if (dir !== undefined) keys.push(`path:${tool}:${dir}`);
  return keys;
}

/** A short, stable key for a tool kind. */
export function toolKey(facts: ToolFacts): string {
  return facts.kind === "shell" ? "shell" : facts.kind === "write" ? "write" : facts.kind === "read" ? "read" : "other";
}

/** The directory a path sits in, project-relative and normalised. */
export function projectDir(path: string): string | undefined {
  const clean = String(path ?? "").replace(/\\/g, "/").trim();
  if (clean === "") return undefined;
  const cut = clean.lastIndexOf("/");
  const dir = cut < 0 ? "." : clean.slice(0, cut);
  if (dir === "" || dir === ".") return ".";
  if (dir.startsWith("~") || dir.startsWith("/") || /^[a-zA-Z]:\//.test(dir) || dir.split("/").includes("..")) {
    return undefined;
  }
  return dir;
}

/** True when a stored grant already covers this call. */
export function hasGrant(facts: ToolFacts, grants: ReadonlySet<string>): boolean {
  if (grants.size === 0) return false;
  if (grants.has(`all:${toolKey(facts)}`)) return true;
  if (!facts.path) return false;
  const dir = projectDir(facts.path);
  if (dir === undefined) return false;
  // A grant for `src` covers `src/a.ts` and `src/deep/b.ts`, never `srcx/a.ts`.
  for (const grant of grants) {
    if (!grant.startsWith(`path:${toolKey(facts)}:`)) continue;
    const allowed = grant.slice(`path:${toolKey(facts)}:`.length);
    if (allowed === "." || dir === allowed || dir.startsWith(`${allowed}/`)) return true;
  }
  return false;
}

/**
 * The decision. Pure: same inputs, same answer, no terminal and no clock.
 *
 * A grant beats the mode table, because it is the user saying "yes, and stop
 * asking me about this one".
 */
export function decideToolUse(mode: ExecutionMode, facts: ToolFacts, grants: ReadonlySet<string> = new Set()): ToolVerdict {
  if (mode === "dangerously-skip-permissions") return "allow";

  // Plan mode is a promise about the whole session, so a grant made earlier
  // cannot open a door that plan mode has already closed.
  if (mode === "plan") {
    // Planning is reading. A write or a shell command is refused by name, so the
    // subagent can report it instead of guessing why nothing happened.
    if (facts.kind === "write") return "refuse";
    if (facts.kind === "shell") return isReadOnlyCommand(facts.command ?? "") ? "allow" : "refuse";
    return "allow";
  }

  // From here on, a grant is the user having already said yes to this one.
  if (hasGrant(facts, grants)) return "allow";

  if (mode === "manual") {
    return facts.kind === "read" ? "allow" : "ask";
  }

  if (mode === "edit-automatically") {
    if (facts.kind === "shell") return "ask";
    if (facts.kind === "other") return facts.dangerous ? "ask" : "allow";
    return "allow";
  }

  // auto: the default. Writes run, normal commands run, and only something that
  // can destroy work stops to ask — including a write outside the project, which
  // is the one write that can touch something the run is not working on.
  if (facts.dangerous) return "ask";
  return "allow";
}

/** Why a call was refused, in words the subagent can act on. */
export function refusalReason(mode: ExecutionMode, facts: ToolFacts): string {
  if (mode === "plan") {
    return facts.kind === "shell"
      ? `plan mode does not run shell commands (${facts.summary}). Describe the change instead of making it.`
      : `plan mode does not change files (${facts.summary}). Describe the change instead of making it.`;
  }
  return `the user did not approve this call (${facts.summary}).`;
}

/** The second answer on the card, which depends on what the call would do. */
export function grantLabel(facts: ToolFacts): string {
  const dir = facts.path ? projectDir(facts.path) : undefined;
  if (facts.kind === "read") return "Yes, allow reads for this run";
  if (facts.kind === "write") return dir === undefined ? "Yes, allow writes for this run" : `Yes, allow writes under ${dir}/ for this run`;
  if (facts.kind === "shell") return "Yes, allow shell commands for this run";
  return "Yes, allow this tool for this run";
}

/** The heading of the card: what would happen, in three or four words. */
export function cardTitle(facts: ToolFacts): string {
  if (facts.kind === "shell") return "Bash command";
  if (facts.kind === "write") return "Write file";
  if (facts.kind === "read") return "Read file";
  return "Tool call";
}
