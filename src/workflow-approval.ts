// The workflow approval card.
//
// Claude Code asks before a dynamic workflow starts, because a workflow can spend
// a lot of tokens in a few seconds. Ours now asks too, with the same three
// answers, and it is a card in the middle of the screen rather than a plain
// question, because the decision needs to show the plan and the cost:
//
//   ╭──────────────────────────────────────────────────────────────────────╮
//   │ Run a dynamic workflow?                                              │  <- orange, glowing
//   │ map the source tree by purpose using 5 parallel subagents            │
//   │                                                                      │
//   │ This will start subagents in 2 phases:                               │
//   │ 1. Analyze — 5 agents                                                │
//   │    · "one file each"                                                 │
//   │ 2. Review                                                            │
//   │                                                                      │
//   │ ! 5 agent calls are written in the script. The last run of this size │
//   │   used about 12k tokens. Stop a run any time with /workflows, or     │
//   │   turn these questions off with QRONOS_WORKFLOW_APPROVE=0.           │
//   │                                                                      │
//   │ ▸ 1. Yes, run it                                                     │
//   │   2. View raw script                                                 │
//   │   3. No                                                              │
//   │                                                                      │
//   │ enter choose · 1 2 3 pick · tab amend · ctrl+g edit · esc cancel     │
//   ╰──────────────────────────────────────────────────────────────────────╯
//
// Three rules:
//
//   1. Reading the plan never runs the script. The phase list comes from a brace
//      scan of `export const meta`, so a preview cannot execute anything.
//   2. If there is no terminal to ask in (tests, a script, an E2E run), the run
//      goes ahead. A guard that blocks headless use would be worse than none.
//   3. Saying "No" is free and final: nothing is launched, nothing is saved.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { parseWorkflowMeta, type WorkflowMeta, type WorkflowPhasePreview } from "./workflow-sandbox";
import { shimmerPhase, shimmerText } from "./shimmer";

export type ApprovalLineStyle =
  | "title"
  | "subtitle"
  | "phase"
  | "warn"
  | "option"
  | "option-selected"
  | "code"
  | "hint";

export interface ApprovalLine {
  text: string;
  style: ApprovalLineStyle;
}

/** How eagerly a run is questioned. */
export type ApprovalMode = "ask" | "always" | "never";

export interface ApprovalRequest {
  name: string;
  description?: string;
  script: string;
  phases: WorkflowPhasePreview[];
  /** Agent calls written in the script. An estimate, and labelled as one. */
  estimatedAgents: number;
  /** Tokens a similar run used last time, when we know it. */
  lastTokens?: number;
}

export interface ApprovalState {
  request: ApprovalRequest;
  selected: number;
  mode: "ask" | "script" | "amend";
  amended?: string;
  width: number;
  now: number;
}

const PANEL_WIDTH = 74;
export const APPROVAL_HEIGHT = 26;
/** Automatic questions start at this many written agent calls. */
export const ASK_FROM_AGENTS = 3;

/** `QRONOS_WORKFLOW_APPROVE`: empty / "ask" / "always" / "0" / "off". */
export function approvalModeFromEnv(env: Record<string, string | undefined> = process.env): ApprovalMode {
  const raw = (env.QRONOS_WORKFLOW_APPROVE ?? "").trim().toLowerCase();
  if (raw === "" || raw === "1" || raw === "ask" || raw === "auto") return "ask";
  if (raw === "always" || raw === "yes") return "always";
  if (raw === "0" || raw === "off" || raw === "never" || raw === "no") return "never";
  return "ask";
}

/** Count `agent(` calls. Loops and pipelines make this a lower bound, so say so. */
export function estimateAgentCalls(script: string): number {
  const calls = script.match(/\bagent\s*\(/g)?.length ?? 0;
  const pipelines = script.match(/\bpipeline\s*\(/g)?.length ?? 0;
  const parallels = script.match(/\bparallel\s*\(/g)?.length ?? 0;
  return calls + pipelines * 2 + parallels * 2;
}

/** Build what the card shows. Pure, so it can be tested without a terminal. */
export function approvalRequestFor(script: string, fallbackName?: string): ApprovalRequest {
  const meta: WorkflowMeta = parseWorkflowMeta(script);
  return {
    name: (meta.name ?? fallbackName ?? "workflow").slice(0, 60),
    description: meta.description,
    script,
    phases: meta.phases ?? [],
    estimatedAgents: estimateAgentCalls(script),
  };
}

/** Should this run be questioned? */
export function needsApproval(request: ApprovalRequest, mode: ApprovalMode): boolean {
  if (mode === "never") return false;
  if (mode === "always") return true;
  const planned = request.phases.reduce((total, phase) => total + (phase.agents ?? 0), 0);
  return request.estimatedAgents >= ASK_FROM_AGENTS || planned >= ASK_FROM_AGENTS || request.phases.length > 1;
}

const OPTIONS = ["Yes, run it", "View raw script", "No"] as const;

function row(left: string, right: string, width: number): string {
  if (right === "") return left;
  return `${left}${" ".repeat(Math.max(1, width - left.length - right.length))}${right}`;
}

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
}

function thousands(value: number): string {
  return value.toLocaleString("en-US");
}

/** The whole card, as lines. */
export function buildApprovalLines(state: ApprovalState): ApprovalLine[] {
  const { request } = state;
  const width = Math.max(30, state.width - 4);
  if (state.mode === "script") return scriptLines(state, width);

  const lines: ApprovalLine[] = [];
  lines.push({ text: row("Run a dynamic workflow?", request.name, width), style: "title" });
  if (state.amended !== undefined) {
    lines.push({ text: clip(`  ${state.amended || "(type a new description)"}`, width), style: "subtitle" });
    lines.push({ text: "  typing replaces the description · enter keeps it · esc drops it", style: "hint" });
  } else if (request.description) {
    lines.push({ text: clip(`  ${request.description}`, width), style: "subtitle" });
  }

  if (request.phases.length > 0) {
    lines.push({ text: "", style: "hint" });
    lines.push({
      text: clip(`  This will start subagents in ${request.phases.length} phase${request.phases.length === 1 ? "" : "s"}:`, width),
      style: "subtitle",
    });
    for (const [index, phase] of request.phases.entries()) {
      const count = phase.agents ? ` — ${phase.agents} agent${phase.agents === 1 ? "" : "s"}` : "";
      lines.push({ text: clip(`  ${index + 1}. ${phase.title}${count}`, width), style: "phase" });
      if (phase.prompt) lines.push({ text: clip(`     · "${phase.prompt}"`, width), style: "hint" });
    }
  }

  const planned = request.phases.reduce((total, phase) => total + (phase.agents ?? 0), 0);
  const estimate = Math.max(request.estimatedAgents, planned);
  lines.push({ text: "", style: "hint" });
  const cost = request.lastTokens ? ` About ${thousands(request.lastTokens)} tokens last time.` : "";
  lines.push({
    text: clip(
      `  ! ${estimate > 0 ? `${estimate} agent call${estimate === 1 ? "" : "s"} written in the script.` : "The script decides how much work to do while it runs."}${cost}`,
      width,
    ),
    style: "warn",
  });
  lines.push({ text: clip("    Stop a run at any time with /workflows, or turn these", width), style: "warn" });
  lines.push({ text: clip("    questions off with QRONOS_WORKFLOW_APPROVE=0.", width), style: "warn" });

  lines.push({ text: "", style: "hint" });
  for (const [index, option] of OPTIONS.entries()) {
    const selected = state.selected === index;
    const mark = selected ? "▸" : " ";
    const note = index === 0 ? "  (uses tokens)" : index === 1 ? "  (nothing runs)" : "  (nothing runs)";
    lines.push({
      text: clip(`  ${mark} ${index + 1}. ${option}${note}`, width),
      style: selected ? "option-selected" : "option",
    });
  }

  lines.push({ text: "", style: "hint" });
  lines.push({ text: clip("  enter choose · 1 2 3 pick · tab amend · ctrl+g edit in $EDITOR", width), style: "hint" });
  lines.push({ text: clip("  esc cancel · nothing runs unless you say yes", width), style: "hint" });
  return lines;
}

function scriptLines(state: ApprovalState, width: number): ApprovalLine[] {
  const source = state.request.script.split(/\r?\n/);
  const lines: ApprovalLine[] = [
    { text: row("The script that will run", state.request.name, width), style: "title" },
    { text: "", style: "hint" },
  ];
  // Show the shape, not the whole file: a long script would push the keys off
  // the screen, and the plan above already says what it does.
  const shown = source.slice(0, 18);
  for (const line of shown) lines.push({ text: clip(`  ${line.replace(/\t/g, "  ")}`, width), style: "code" });
  if (source.length > shown.length) {
    lines.push({ text: `  … ${source.length - shown.length} more lines`, style: "hint" });
  }
  lines.push({ text: "", style: "hint" });
  lines.push({ text: "  esc back · ctrl+g edit in $EDITOR", style: "hint" });
  return lines;
}

export interface ApprovalOutcome {
  approved: boolean;
  script: string;
  description?: string;
  /** True when there was no terminal to ask in. */
  skipped?: boolean;
}

export interface ApprovalPromptOptions {
  request: ApprovalRequest;
  theme: Theme;
  done: (outcome: ApprovalOutcome) => void;
  requestRender?: () => void;
  width?: number;
  now?: () => number;
  /** Opens an editor and returns the saved script, or undefined if unchanged. */
  edit?: (script: string) => string | undefined;
}

/**
 * The overlay component. Keys work the same as the rest of the CLI, and the
 * result is delivered once, through `done`.
 */
export class WorkflowApprovalPrompt {
  private readonly options: ApprovalPromptOptions;
  private readonly theme: Theme;
  private readonly requestRender: () => void;
  private readonly width: number;
  private readonly now: () => number;

  selected = 0;
  mode: "ask" | "script" | "amend" = "ask";
  amended?: string;
  script: string;
  finished = false;

  constructor(options: ApprovalPromptOptions) {
    this.options = options;
    this.theme = options.theme;
    this.requestRender = options.requestRender ?? (() => {});
    this.width = options.width ?? PANEL_WIDTH;
    this.now = options.now ?? Date.now;
    this.script = options.request.script;
  }

  dispose(): void {}

  invalidate(): void {}

  render(width: number): string[] {
    const panelWidth = Math.max(30, Math.min(this.width, width));
    const lines = buildApprovalLines({
      request: { ...this.options.request, script: this.script },
      selected: this.selected,
      mode: this.mode,
      amended: this.amended,
      width: panelWidth,
      now: this.now(),
    });
    const body = lines.map((line) => this.colour(line, panelWidth));
    const inner = Math.max(1, panelWidth - 2);
    const border = this.border();
    const out = [border(`╭${"─".repeat(inner)}╮`)];
    for (const line of body) {
      out.push(`${border("│")}${truncateToWidth(`${line}${" ".repeat(Math.max(0, inner - visible(line)))}`, inner, "…", false)}${border("│")}`);
    }
    out.push(border(`╰${"─".repeat(inner)}╯`));
    return out;
  }

  handleInput(data: string): void {
    if (this.amended !== undefined) {
      if (matchesKey(data, "escape")) {
        this.amended = undefined;
      } else if (matchesKey(data, "return")) {
        this.finish(true);
        return;
      } else if (matchesKey(data, "backspace")) {
        this.amended = this.amended.slice(0, -1);
      } else if (data.length === 1 && data >= " ") {
        this.amended += data;
      }
      this.requestRender();
      return;
    }

    if (matchesKey(data, "escape")) {
      if (this.mode === "script") {
        this.mode = "ask";
        // Back on the first option: Enter should mean "run it", not "open the
        // script again", or the card would feel stuck.
        this.selected = 0;
        this.requestRender();
        return;
      }
      this.finish(false);
      return;
    }
    if (data === "\u0007" /* ctrl+g */) {
      this.openEditor();
      return;
    }
    if (matchesKey(data, "tab")) {
      this.mode = "ask";
      this.amended = this.options.request.description ?? "";
      this.requestRender();
      return;
    }
    if (matchesKey(data, "return")) {
      this.choose(this.selected, true);
      return;
    }
    if (matchesKey(data, "up")) {
      this.selected = Math.max(0, this.selected - 1);
      this.requestRender();
      return;
    }
    if (matchesKey(data, "down")) {
      this.selected = Math.min(OPTIONS.length - 1, this.selected + 1);
      this.requestRender();
      return;
    }
    if (data === "1" || data === "2" || data === "3") {
      this.choose(Number(data) - 1, false);
    }
  }

  /** Pick an option. `confirm` means the user pressed Enter on it. */
  choose(index: number, confirm: boolean): void {
    this.selected = Math.max(0, Math.min(OPTIONS.length - 1, index));
    if (this.selected === 0) {
      if (confirm) this.finish(true);
      else this.requestRender();
      return;
    }
    if (this.selected === 1) {
      this.mode = "script";
      this.requestRender();
      return;
    }
    this.finish(false);
  }

  private openEditor(): void {
    const edited = this.options.edit?.(this.script);
    if (typeof edited === "string" && edited.trim() !== "") {
      this.script = edited;
      this.mode = "ask";
      this.finished = false;
    }
    this.requestRender();
  }

  private finish(approved: boolean): void {
    if (this.finished) return;
    this.finished = true;
    this.options.done({
      approved,
      script: this.script,
      description: this.amended ?? this.options.request.description,
    });
  }

  private colour(line: ApprovalLine, width: number): string {
    const theme = this.theme as unknown as { fg?: (slot: string, text: string) => string };
    const paint = (slot: string, fallback = line.text) => {
      try {
        return theme.fg ? theme.fg(slot, line.text) : fallback;
      } catch {
        return fallback;
      }
    };
    if (line.style === "title") {
      // The same 3 s pale-orange band as the header, so the heading glows.
      return truncateToWidth(shimmerText(line.text, shimmerPhase(this.now()), { bold: true }), width - 2, "…", false);
    }
    switch (line.style) {
      case "subtitle":
        return paint("accent");
      case "phase":
        return paint("text");
      case "warn":
        return paint("warning");
      case "option-selected":
        return paint("accent", line.text);
      case "option":
        return paint("text");
      case "code":
        return paint("muted");
      case "hint":
        return paint("muted");
      default:
        return line.text;
    }
  }

  private border(): (text: string) => string {
    const theme = this.theme as unknown as { fg?: (slot: string, text: string) => string };
    return (text: string) => {
      try {
        return theme.fg ? theme.fg("border", text) : text;
      } catch {
        return text;
      }
    };
  }
}

/** Visible width, ignoring colour codes. */
function visible(text: string): number {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/g, "").length;
}

/** Open `script` in the user's editor and read it back. */
export function editScriptInEditor(script: string): string | undefined {
  const editor = process.env.VISUAL || process.env.EDITOR;
  if (!editor) return undefined;
  let dir: string | undefined;
  try {
    dir = mkdtempSync(join(tmpdir(), "qronos-wf-edit-"));
    const file = join(dir, "workflow.js");
    writeFileSync(file, script, "utf8");
    // The editor is the user's own program, run once, with no shell strings from
    // the model: the path is a temp file we created.
    const parts = editor.split(/\s+/).filter(Boolean);
    const result = spawnSync(parts[0]!, [...parts.slice(1), file], { stdio: "inherit" });
    if (result.error || result.status !== 0) return undefined;
    const updated = readFileSync(file, "utf8");
    return updated.trim() === script.trim() ? undefined : updated;
  } catch {
    return undefined;
  } finally {
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // a temp file left behind is not worth an error
      }
    }
  }
}

/**
 * Ask, when there is something to ask with.
 *
 * No `ui.custom` means no terminal (a test, a script, an E2E run), and then the
 * run goes ahead: a guard that blocks headless use would be worse than none.
 */
export async function askWorkflowApproval(
  ctx: { ui?: { custom?: unknown } } | undefined,
  request: ApprovalRequest,
  options: { mode?: ApprovalMode; width?: number; now?: () => number; edit?: (script: string) => string | undefined } = {},
): Promise<ApprovalOutcome> {
  const mode = options.mode ?? approvalModeFromEnv();
  if (!needsApproval(request, mode)) return { approved: true, script: request.script, description: request.description };
  const custom = (ctx as { ui?: { custom?: unknown } } | undefined)?.ui?.custom;
  if (typeof custom !== "function") {
    return { approved: true, script: request.script, description: request.description, skipped: true };
  }

  let outcome: ApprovalOutcome | undefined;
  const theme = (ctx as { theme?: Theme }).theme as Theme;
  await (custom as (...args: unknown[]) => Promise<unknown>).call(ctx, (tui: any, panelTheme: Theme, _kb: any, done: () => void) =>
    new WorkflowApprovalPrompt({
      request,
      theme: panelTheme ?? theme,
      done: (result) => {
        outcome = result;
        done();
      },
      requestRender: () => tui?.requestRender?.(),
      width: options.width,
      now: options.now,
      edit: options.edit ?? editScriptInEditor,
    }),
  { overlay: true, overlayOptions: { anchor: "center", width: options.width ?? PANEL_WIDTH, maxHeight: APPROVAL_HEIGHT } });

  // Closing the card without choosing means "no": silence must never start a run.
  return outcome ?? { approved: false, script: request.script };
}
