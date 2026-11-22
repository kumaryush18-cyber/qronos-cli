// The workflow panel, part one: the text.
//
// Pure. No pi-tui, no terminal, no timers, no disk. It turns a job into lines and
// a style for each line, and the panel adds colour, the shimmer and the box. That
// split is why the fiddly parts (widths, truncation, "what does a row say") can be
// tested without a terminal, and why the same lines work in a log or a screenshot.
//
// The shape, top to bottom:
//
//   ✻ auth-audit            running · 3 running · 9 done · 42.1k tokens · 2m 05s
//   ┆ journal wf_qhj6qy01 · resumed from wf_qhj6qy00
//     ▸ Understand          1 agent                       ███        2.2k
//     ▸ Review              3 agents       ✗ 1            ██████████ 6.4k
//    ✓ routes.ts            08:12            ████████    7.1k  19s
//    ┆ ↺ middleware.ts      05:44            ██████      5.0k   0s  replayed
//
// The `┆` rail is the "flow line": it draws the eye down the run in the same
// order the work happened.
import { formatTokens } from "./workflow-types";
import type { WorkflowJob } from "./workflow-jobs";
import { formatDuration } from "./workflow-glyphs";

export type PanelLineStyle =
  | "title"
  | "job"
  | "job-selected"
  | "phase"
  | "phase-active"
  | "phase-failed"
  | "agent-ok"
  | "agent-bad"
  | "agent-replay"
  | "agent-running"
  | "detail"
  | "hint"
  | "empty"
  | "rail";

export interface PanelLine {
  text: string;
  style: PanelLineStyle;
}

/** One agent, flattened for drawing. */
export interface PanelAgentView {
  id: string;
  label: string;
  ok: boolean;
  replayed: boolean;
  tokens: number;
  durationMs: number;
  error?: string;
  phase?: string;
  depth: number;
  /** True while the agent is still talking to the model. */
  running: boolean;
  /** The answer, when a recent event still has it. Only used in the detail view. */
  answer?: string;
}

export interface PanelPhaseView {
  name: string;
  agents: number;
  failed: number;
  tokens: number;
  /** True when agents are still working inside this phase. */
  active: boolean;
}

/** One job, flattened for drawing. */
export interface PanelJobView {
  id: string;
  name: string;
  state: string;
  elapsedMs: number;
  running: number;
  done: number;
  failed: number;
  replayed: number;
  tokens: number;
  phases: PanelPhaseView[];
  agents: PanelAgentView[];
  resumedFrom?: string;
  journalPath?: string;
  error?: string;
  /** The script's first line that says something, for the detail view. */
  scriptHint?: string;
}

export type PanelMode = "list" | "agent";

export interface PanelState {
  jobs: readonly PanelJobView[];
  job: PanelJobView | undefined;
  selectedAgent: number;
  mode: PanelMode;
  width: number;
  now: number;
  /** Lines the overlay allows, so a long agent list does not push the keys off. */
  height?: number;
  /** Frame counter, so the shimmer can move without the view knowing about time. */
  phase?: number;
}

const RAIL = "┆";
/** How many agent rows the list shows before it says how many are hidden. */
const MAX_AGENT_ROWS = 12;

/** Inner width: the box costs two columns, plus a space either side. */
export function innerWidth(width: number): number {
  return Math.max(24, width - 4);
}

/** Spread `left` and `right` to the full width; the right side keeps its space. */
function row(left: string, right: string, width: number): string {
  if (right === "") return left;
  const space = Math.max(1, width - left.length - right.length);
  return `${left}${" ".repeat(space)}${right}`;
}

function truncate(text: string, limit: number): string {
  const single = text.replace(/\s+/g, " ").trim();
  if (single.length <= limit) return single;
  return limit <= 1 ? single.slice(0, limit) : `${single.slice(0, limit - 1)}…`;
}

/** A bar of `width` cells, scaled to the largest value in the table. */
export function panelBar(value: number, max: number, width = 8): string {
  const safeMax = Math.max(1, max);
  const filled = value <= 0 ? 0 : Math.max(1, Math.round((value / safeMax) * width));
  return "█".repeat(Math.min(width, filled)).padEnd(width);
}

function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

/** `wf_qhj6qy01` -> `qhj6qy01`, which is the part a person reads. */
function shortId(id: string): string {
  return id.startsWith("wf_") ? id.slice(3) : id;
}

/**
 * Flatten a job into what the panel draws.
 *
 * Everything here is read-only. The panel never owns a job, so closing it can
 * never lose a run.
 */
export function toPanelJob(job: WorkflowJob, now: number = Date.now()): PanelJobView {
  const active = job.state === "running" || job.state === "queued" || job.state === "paused";
  const lastPhase = job.phases.at(-1);
  const agents: PanelAgentView[] = job.agents.map((agent) => ({
    id: agent.id,
    label: agent.label,
    ok: agent.ok,
    replayed: agent.replayed === true,
    tokens: agent.usage?.total ?? 0,
    durationMs: agent.durationMs,
    error: agent.error,
    phase: agent.phase,
    depth: agent.depth,
    running: false,
    answer: answerFor(job, agent.id),
  }));

  // `agents` only holds finished ones, so the ones still working are the ones
  // whose `agent_start` has no `agent_end` after it. They get a row too: a panel
  // that shows nothing until an agent finishes looks broken exactly when you
  // most want to look at it.
  const started = job.recent.filter((event) => event.type === "agent_start");
  const ended = new Set(job.recent.filter((event) => event.type === "agent_end").map((event) => (event as { id?: string }).id));
  const working = active ? started.filter((event) => !ended.has((event as { id?: string }).id)) : [];
  const stillRunning = Math.max(0, Math.min(job.running, working.length));
  for (const [index, event] of working.slice(-stillRunning).entries()) {
    const start = event as { at?: number; label?: string; id?: string; phase?: string; depth?: number };
    agents.push({
      id: start.id ?? `running-${index}`,
      label: start.label ?? "working",
      ok: false,
      replayed: false,
      tokens: 0,
      // A real `agent_start` carries a real timestamp; a hand-built one may not.
      // Clamp to a day, so a bad clock cannot print a silly number.
      durationMs: Math.min(86_400_000, Math.max(0, now - (start.at ?? now))),
      phase: start.phase ?? lastPhase,
      depth: start.depth ?? 1,
      running: true,
    });
  }

  const phases: PanelPhaseView[] = job.phaseStats.map((stat) => ({
    name: stat.name,
    agents: stat.agents,
    failed: stat.failed,
    tokens: stat.tokens,
    active: active && stat.name === lastPhase,
  }));

  return {
    id: job.id,
    name: job.name,
    state: job.state,
    elapsedMs: (job.finishedAt ?? now) - job.startedAt,
    running: job.running,
    done: job.done,
    failed: job.failed,
    replayed: job.replayed,
    tokens: job.tokens.total,
    phases,
    agents,
    resumedFrom: job.resumedFrom,
    journalPath: job.journalPath,
    error: job.error,
    scriptHint: firstMeaningfulLine(job.script),
  };
}

/** The answer text for an agent, from the recent events the job keeps. */
function answerFor(job: WorkflowJob, id: string): string | undefined {
  for (let index = job.recent.length - 1; index >= 0; index -= 1) {
    const event = job.recent[index]!;
    if (event.type !== "agent_end" || event.id !== id) continue;
    const text = (event as { text?: string }).text;
    return text && text.trim() !== "" ? text : undefined;
  }
  return undefined;
}

/** The first line of a script that is not blank or just `export const meta`. */
function firstMeaningfulLine(script: string): string | undefined {
  for (const line of script.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed === "}" || trimmed.startsWith("//")) continue;
    if (trimmed.startsWith("export const meta")) continue;
    return truncate(trimmed, 90);
  }
  return undefined;
}

/** The whole panel, as lines. */
export function buildPanelLines(state: PanelState): PanelLine[] {
  return clip(state.job ? listLines(state) : emptyLines(state), state.width);
}

function clip(lines: PanelLine[], width: number): PanelLine[] {
  const limit = width - 2;
  return lines.map((line) =>
    line.text.length <= limit ? line : { ...line, text: `${line.text.slice(0, Math.max(0, limit - 1))}…` },
  );
}

function emptyLines(state: PanelState): PanelLine[] {
  const width = innerWidth(state.width);
  return [
    { text: row("Workflows", "", width), style: "title" },
    { text: "", style: "empty" },
    { text: "Nothing has run in this session yet.", style: "empty" },
    { text: "", style: "empty" },
    { text: "Write the word ultracode in a prompt to start one:", style: "hint" },
    { text: "  ultracode audit every route in src/routes", style: "hint" },
    { text: "", style: "empty" },
    { text: "Esc close", style: "hint" },
  ];
}

function listLines(state: PanelState): PanelLine[] {
  const width = innerWidth(state.width);
  const job = state.job!;
  const lines: PanelLine[] = [];

  if (state.mode === "agent") return agentLines(state, job, width);

  const live = job.state === "running" || job.state === "queued" || job.state === "paused";
  const counts = live
    ? `${job.running} running · ${job.done} done${job.failed > 0 ? ` · ${job.failed} failed` : ""}`
    : `${job.done} agent${job.done === 1 ? "" : "s"}${job.failed > 0 ? ` · ${job.failed} failed` : ""}`;
  const stateWord = job.state === "paused" ? "paused" : job.state === "done" ? "finished" : job.state;

  lines.push({
    text: row(truncate(job.name, Math.max(10, width - 44)), `${counts} · ${formatTokens(job.tokens)} tokens · ${formatDuration(job.elapsedMs)}`, width),
    style: "title",
  });

  const meta: string[] = [`${stateWord}`, shortId(job.id)];
  if (job.resumedFrom) meta.push(`resumed from ${shortId(job.resumedFrom)}`);
  if (job.replayed > 0) meta.push(`${job.replayed} replayed`);
  if (state.jobs.length > 1) meta.push(`↑↓ job ${state.jobs.indexOf(job) + 1}/${state.jobs.length}`);
  lines.push({ text: `  ${RAIL} ${truncate(meta.join(" · "), width - 4)}`, style: "detail" });

  if (job.phases.length > 0) {
    const maxPhase = Math.max(1, ...job.phases.map((phase) => phase.tokens));
    lines.push({ text: "", style: "empty" });
    for (const phase of job.phases) {
      const failed = phase.failed > 0 ? `✗ ${phase.failed}` : "";
      const left = `  ▸ ${truncate(phase.name, Math.max(8, width - 34))}`;
      const middle = `${phase.agents} agent${phase.agents === 1 ? "" : "s"}`;
      const bar = panelBar(phase.tokens, maxPhase, 10);
      const tokens = formatTokens(phase.tokens).padStart(6);
      lines.push({
        text: row(`${left}  ${middle.padEnd(11)}${failed.padEnd(4)}`, `${bar} ${tokens}`, width),
        style: phase.active ? "phase-active" : phase.failed > 0 ? "phase-failed" : "phase",
      });
    }
  }

  const agents = job.agents;
  if (agents.length > 0) {
    const maxTokens = Math.max(1, ...agents.map((agent) => agent.tokens));
    const sorted = sortForPanel(agents);
    const shown = state.height && state.height > 0 ? sorted.slice(0, Math.max(3, MAX_AGENT_ROWS)) : sorted.slice(0, MAX_AGENT_ROWS);
    lines.push({ text: "", style: "empty" });
    for (const [index, agent] of shown.entries()) {
      const selected = state.mode === "list" && index === state.selectedAgent;
      const mark = agent.running ? "✻" : agent.replayed ? "↺" : agent.ok ? "✓" : "✗";
      const rail = index === shown.length - 1 ? " " : RAIL;
      const indent = "  ".repeat(Math.max(0, agent.depth - 1));
      const label = truncate(`${indent}${agent.label}`, Math.max(10, width - 40));
      const bar = panelBar(agent.tokens, maxTokens, 8);
      const tokens = formatTokens(agent.tokens).padStart(6);
      const time = agent.replayed ? "  skip" : formatDuration(agent.durationMs).padStart(6);
      const flag = agent.replayed ? "  replayed" : "";
      const left = ` ${selected ? "▸" : rail} ${mark} ${label}`;
      lines.push({
        text: row(left, `${bar} ${tokens} ${time}${flag}`, width),
        style: agent.running
          ? "agent-running"
          : agent.replayed
            ? "agent-replay"
            : agent.ok
              ? selected
                ? "job-selected"
                : "agent-ok"
              : "agent-bad",
      });
      if (!agent.ok && agent.error) {
        lines.push({ text: `     ${truncate(agent.error, width - 7)}`, style: "detail" });
      }
    }
    if (agents.length > shown.length) {
      lines.push({ text: `   … ${agents.length - shown.length} more`, style: "detail" });
    }
  }

  if (job.error && job.state !== "running") {
    lines.push({ text: "", style: "empty" });
    lines.push({ text: `  ${truncate(job.error, width - 4)}`, style: "agent-bad" });
  }

  lines.push({ text: "", style: "empty" });
  lines.push({
    text: truncate(
      `${job.state === "running" ? "space pause" : job.state === "paused" ? "space resume" : "space retry"} · x stop · enter agent · ↑↓ job · esc close`,
      width,
    ),
    style: "hint",
  });
  return lines;
}

/** Something running first, then failures, then the expensive ones. */
function sortForPanel(agents: PanelAgentView[]): PanelAgentView[] {
  return [...agents].sort((a, b) => {
    if (a.running !== b.running) return a.running ? -1 : 1;
    if (a.ok !== b.ok) return a.ok ? 1 : -1;
    return b.tokens - a.tokens;
  });
}

function agentLines(state: PanelState, job: PanelJobView, width: number): PanelLine[] {
  const sorted = sortForPanel(job.agents);
  const agent = sorted[Math.min(state.selectedAgent, Math.max(0, sorted.length - 1))];
  if (!agent) return emptyLines(state);
  const lines: PanelLine[] = [
    { text: row(truncate(agent.label, Math.max(10, width - 24)), agent.replayed ? "replayed" : agent.running ? "running" : agent.ok ? "done" : "failed", width), style: "title" },
    { text: `${RAIL} ${job.name} · ${shortId(job.id)}`, style: "detail" },
    { text: "", style: "empty" },
  ];
  const facts = [
    ["phase", agent.phase ?? "(none)"],
    ["cost", `${formatTokens(agent.tokens)} tokens`],
    ["time", agent.replayed ? "replayed from the journal" : formatDuration(agent.durationMs)],
    ["depth", agent.depth > 1 ? `nested, level ${agent.depth}` : "top level"],
  ];
  for (const [key, value] of facts) {
    lines.push({ text: `  ${key.padEnd(6)} ${truncate(value, width - 10)}`, style: "detail" });
  }
  if (agent.error) {
    lines.push({ text: "", style: "empty" });
    lines.push({ text: "  error", style: "title" });
    for (const line of wrap(agent.error, width - 4)) lines.push({ text: `  ${line}`, style: "agent-bad" });
  }
  if (agent.answer) {
    lines.push({ text: "", style: "empty" });
    lines.push({ text: "  answer", style: "title" });
    for (const line of wrap(agent.answer, width - 4).slice(0, 10)) lines.push({ text: `  ${line}`, style: "detail" });
  }
  if (job.scriptHint) {
    lines.push({ text: "", style: "empty" });
    lines.push({ text: `  script ${job.scriptHint}`, style: "hint" });
  }
  lines.push({ text: "", style: "empty" });
  lines.push({ text: "↑↓ agent · esc back", style: "hint" });
  return lines;
}

/** Wrap on words, so a long error does not run off the edge. */
export function wrap(text: string, width: number): string[] {
  const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (words.length === 0) return [];
  const limit = Math.max(8, width);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    // A single word longer than the line (a path, a hash, a stack frame) is cut
    // into pieces of the line width. Cutting is better than dropping it.
    if (word.length > limit) {
      if (current !== "") {
        lines.push(current);
        current = "";
      }
      for (let index = 0; index < word.length; index += limit) lines.push(word.slice(index, index + limit));
      continue;
    }
    if (current === "") current = word;
    else if (current.length + 1 + word.length <= limit) current = `${current} ${word}`;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current !== "") lines.push(current);
  return lines;
}

/** Move the selection inside a list of `count` items, clamped. */
export function moveIndex(selected: number, count: number, delta: number): number {
  if (count <= 0) return 0;
  return Math.min(count - 1, Math.max(0, selected + delta));
}

/** Just the numbers, for the one-line status shown after closing the panel. */
export function panelSummary(job: PanelJobView | undefined): string {
  if (!job) return "";
  const tokens = formatTokens(job.tokens);
  if (job.state === "running" || job.state === "queued") {
    return `${job.name} · ${job.running} running · ${job.done} done · ${tokens} tokens`;
  }
  if (job.state === "paused") return `${job.name} paused · ${job.done} done · ${tokens} tokens`;
  const mark = job.state === "done" ? "✓" : "✗";
  return `${mark} ${job.name} · ${job.done} agents · ${tokens} tokens · ${formatDuration(job.elapsedMs)}`;
}
