// The workflow panel, part one: the text.
//
// Pure. No pi-tui, no terminal, no timers, no disk. It turns a job into lines and
// a style for each line, and the panel adds colour, the shimmer and the box. That
// split is why the fiddly parts (widths, truncation, "what does a row say") can be
// tested without a terminal, and why the same lines work in a log or a screenshot.
//
// The layout is Claude Code's, because it is the right one: two columns, phases on
// the left, the agents of the selected phase on the right. A single list of mixed
// rows made you scroll to connect a phase with its work.
//
//   analyze-oh-my-pi-src                          0/5 agents · 36s
//   Map the oh-my-pi source tree by purpose using 5 parallel subagents
//
//   Phases                    │ Analyze · 5 agents
//   ▸ 1 Analyze 0/5           │ • coding-agent   deepseek-v4-flash · 0 tokens   29s
//                             │ • ai-and-tui     deepseek-v4-flash · 0 tokens   29s
//                             │ ↻ ts-support     · queued
//                             │ ↻ rust-shell     · queued
//
//   ↑/↓ phase · p pause · x stop · s save · enter view · esc close
import { formatTokens, type WorkflowUsage } from "./workflow-types";
import type { WorkflowJob } from "./workflow-jobs";
import { formatDuration } from "./workflow-glyphs";

export type PanelLineStyle =
  | "title"
  | "description"
  | "column-head"
  | "phase"
  | "phase-selected"
  | "phase-active"
  | "phase-failed"
  | "agent-ok"
  | "agent-bad"
  | "agent-replay"
  | "agent-running"
  | "agent-queued"
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
  /** Declared in the plan but not started yet. */
  queued?: boolean;
  /** The model this agent used, when it is known. */
  model?: string;
}

export interface PanelPhaseView {
  name: string;
  /** Agents in this phase that have finished. */
  done: number;
  /** How many agents this phase will run: the plan's number, or what was seen. */
  planned: number;
  failed: number;
  tokens: number;
  /** True when agents are still working inside this phase. */
  active: boolean;
}

/** One job, flattened for drawing. */
export interface PanelJobView {
  id: string;
  name: string;
  description?: string;
  state: string;
  elapsedMs: number;
  running: number;
  done: number;
  failed: number;
  replayed: number;
  tokens: number;
  /** Total agents the script expects, when it said so. */
  planned: number;
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
  /** Phase under the cursor, which decides the right-hand column. */
  selectedPhase: number;
  selectedAgent: number;
  mode: PanelMode;
  width: number;
  now: number;
  /** Lines the overlay allows, so a long agent list does not push the keys off. */
  height?: number;
  /** Frame counter, so the shimmer can move without the view knowing about time. */
  phase?: number;
}

/** How many agent rows the right column shows before it says how many are hidden. */
const MAX_AGENT_ROWS = 14;

/** Column split: phases on the left, agents on the right. */
export function columnWidths(width: number): { left: number; right: number } {
  const inner = Math.max(30, width - 2);
  const left = Math.min(30, Math.max(20, Math.round(inner * 0.4)));
  // The divider costs two columns: one bar, one space.
  return { left, right: Math.max(16, inner - left - 2) };
}

/** Inner width: the box costs two columns. */
export function innerWidth(width: number): number {
  return Math.max(30, width - 2);
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

/** The model name as short as it stays readable: `deepseek-v4-flash[1m]`. */
export function shortModel(model: string | undefined): string {
  if (!model) return "";
  const base = model.includes("/") ? model.slice(model.lastIndexOf("/") + 1) : model;
  return base.length > 22 ? `${base.slice(0, 21)}…` : base;
}

/**
 * Flatten a job into what the panel draws.
 *
 * Everything here is read-only. The panel never owns a job, so closing it can
 * never lose a run.
 */
export function toPanelJob(job: WorkflowJob, now: number = Date.now()): PanelJobView {
  const active = job.state === "running" || job.state === "queued" || job.state === "paused";
  const agents: PanelAgentView[] = job.agents.map((agent) => ({
    id: agent.id,
    label: agent.label,
    ok: agent.ok,
    replayed: agent.replayed === true,
    tokens: (agent.usage as WorkflowUsage | undefined)?.total ?? 0,
    durationMs: agent.durationMs,
    error: agent.error,
    phase: agent.phase,
    depth: agent.depth,
    running: false,
    queued: false,
    model: agent.model,
    answer: undefined,
  })) as PanelAgentView[];

  // `agents` only holds finished ones, so the ones still working are the ones
  // whose `agent_start` has no `agent_end` after it. They get a row too: a panel
  // that shows nothing until an agent finishes looks broken exactly when you
  // most want to look at it.
  const started = job.recent.filter((event) => event.type === "agent_start");
  const ended = new Set(job.recent.filter((event) => event.type === "agent_end").map((event) => (event as { id?: string }).id));
  const working = active ? started.filter((event) => !ended.has((event as { id?: string }).id)) : [];
  const stillRunning = Math.max(0, Math.min(job.running, working.length));
  for (const [index, event] of working.slice(-stillRunning).entries()) {
    const start = event as { at?: number; label?: string; id?: string; phase?: string; depth?: number; model?: string };
    agents.push({
      id: start.id ?? `running-${index}`,
      label: start.label ?? "working",
      ok: false,
      replayed: false,
      tokens: 0,
      // A real `agent_start` carries a real timestamp; a hand-built one may not.
      // Clamp to a day, so a bad clock cannot print a silly number.
      durationMs: Math.min(86_400_000, Math.max(0, now - (start.at ?? now))),
      phase: start.phase,
      depth: start.depth ?? 1,
      running: true,
      queued: false,
      model: start.model,
    });
  }

  // The plan says which phases exist before they start, and how many agents each
  // one expects. Queued rows come from the difference between that and reality.
  const plannedFor = (name: string | undefined) =>
    job.planned?.reduce((total, phase) => (name && phase.title === name ? phase.agents : total), 0) ?? 0;
  const seen = new Set<string>();
  const phases: PanelPhaseView[] = [];
  const addPhase = (name: string) => {
    if (name === "" || seen.has(name)) return;
    seen.add(name);
    const stat = job.phaseStats.find((entry) => entry.name === name);
    const inPhase = agents.filter((agent) => agent.phase === name);
    const finished = inPhase.filter((agent) => !agent.running && !agent.queued);
    const planned = Math.max(plannedFor(name), inPhase.filter((agent) => !agent.queued).length, stat?.agents ?? 0);
    const queued = active ? Math.max(0, plannedFor(name) - inPhase.length) : 0;
    for (let index = 0; index < queued; index += 1) {
      agents.push({
        id: `queued-${name}-${index}`,
        label: "waiting",
        ok: false,
        replayed: false,
        tokens: 0,
        durationMs: 0,
        phase: name,
        depth: 1,
        running: false,
        queued: true,
      });
    }
    phases.push({
      name,
      done: finished.length,
      planned,
      failed: stat?.failed ?? finished.filter((agent) => !agent.ok).length,
      tokens: stat?.tokens ?? 0,
      active: active && job.phases.at(-1) === name,
    });
  };
  for (const phase of job.planned ?? []) addPhase(phase.title);
  for (const phase of job.phases) addPhase(phase);
  for (const agent of agents) if (agent.phase) addPhase(agent.phase);

  // Phases with no name at all still get one bucket, so the right column is never
  // empty while agents exist.
  const unnamed = agents.filter((agent) => !agent.phase);
  if (unnamed.length > 0 && phases.length === 0) {
    phases.push({
      name: "Agents",
      done: unnamed.filter((agent) => !agent.running).length,
      planned: unnamed.length,
      failed: 0,
      tokens: 0,
      active,
    });
    for (const agent of unnamed) agent.phase = "Agents";
  }

  const plannedTotal = (job.planned ?? []).reduce((total, phase) => total + phase.agents, 0);

  return {
    id: job.id,
    name: job.name,
    description: job.description,
    state: job.state,
    elapsedMs: (job.finishedAt ?? now) - job.startedAt,
    running: job.running,
    done: job.done,
    failed: job.failed,
    replayed: job.replayed,
    tokens: job.tokens.total,
    planned: Math.max(plannedTotal, phases.reduce((total, phase) => total + phase.planned, 0)),
    phases,
    agents,
    resumedFrom: job.resumedFrom,
    journalPath: job.journalPath,
    error: job.error,
    scriptHint: firstMeaningfulLine(job.script),
  };
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
  const limit = Math.max(10, width - 2);
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
  if (state.mode === "agent") return agentLines(state, job, width);

  const lines: PanelLine[] = [];
  const live = job.state === "running" || job.state === "queued" || job.state === "paused";
  const total = job.planned > 0 ? job.planned : job.done + job.failed;
  const agents = `${job.done}/${total === 0 ? "?" : total} agents`;
  const right = `${agents} · ${formatDuration(job.elapsedMs)}`;
  lines.push({ text: row(truncate(job.name, Math.max(12, width - right.length - 2)), right, width), style: "title" });

  if (job.description) {
    lines.push({ text: truncate(job.description, width), style: "description" });
  }

  const meta: string[] = [];
  if (job.state === "paused") meta.push("paused");
  else if (job.state === "cancelled") meta.push("stopped");
  else if (job.state === "failed") meta.push("failed");
  if (job.failed > 0) meta.push(`${job.failed} failed`);
  if (job.replayed > 0) meta.push(`${job.replayed} replayed`);
  if (job.tokens > 0) meta.push(`${formatTokens(job.tokens)} tokens`);
  if (state.jobs.length > 1) {
    const position = state.jobs.findIndex((entry) => entry.id === job.id);
    meta.push(`job ${position + 1}/${state.jobs.length}`);
  }
  if (meta.length > 0) lines.push({ text: truncate(`  ${meta.join(" · ")}`, width), style: "detail" });
  void live;

  const { left, right: rightWidth } = columnWidths(state.width);
  const phase = job.phases[Math.min(state.selectedPhase, Math.max(0, job.phases.length - 1))];
  const inPhase = phase ? agentsIn(job, phase.name) : [];
  const rowCount = Math.min(Math.max(job.phases.length, inPhase.length, 1), MAX_AGENT_ROWS);
  lines.push({ text: "", style: "empty" });
  const phaseHead = phase
    ? `${truncate(phase.name, Math.max(8, rightWidth - 12))} · ${phase.planned || inPhase.length} agent${(phase.planned || inPhase.length) === 1 ? "" : "s"}`
    : "";
  lines.push({ text: `${"Phases".padEnd(left)}│ ${phaseHead}`, style: "column-head" });

  for (let index = 0; index < rowCount; index += 1) {
    const entry = job.phases[index];
    const selected = index === Math.min(state.selectedPhase, Math.max(0, job.phases.length - 1));
    const leftCell = !entry
      ? ""
      : `${selected ? "▸" : " "} ${index + 1} ${truncate(entry.name, Math.max(6, left - 7))} ${entry.done}/${entry.planned || entry.done}`;
    const agentCell = rowAgent(inPhase[index], rightWidth);
    lines.push({
      text: `${leftCell.padEnd(left)}│ ${agentCell.text}`,
      style: entry
        ? entry.active
          ? "phase-active"
          : entry.failed > 0
            ? "phase-failed"
            : selected
              ? "phase-selected"
              : "phase"
        : "detail",
    });
  }

  const hidden = inPhase.length - Math.min(inPhase.length, MAX_AGENT_ROWS);
  if (hidden > 0) lines.push({ text: `  … ${hidden} more agents in ${phase?.name ?? "this phase"}`, style: "detail" });

  if (job.error && job.state !== "running") {
    lines.push({ text: "", style: "empty" });
    lines.push({ text: truncate(`  ${job.error}`, width), style: "agent-bad" });
  }

  lines.push({ text: "", style: "empty" });
  lines.push({
    text: truncate(
      `${job.state === "running" ? "p pause" : job.state === "paused" ? "p resume" : "p retry"} · x stop · s save · enter view · ↑↓ phase · esc close`,
      width,
    ),
    style: "hint",
  });
  return lines;
}

function agentsIn(job: PanelJobView, phase: string): PanelAgentView[] {
  return sortForPanel(job.agents.filter((agent) => agent.phase === phase));
}

/** One agent cell for the right-hand column: label, model, tokens, time. */
function rowAgent(agent: PanelAgentView | undefined, width: number): { text: string; style: PanelLineStyle } {
  if (!agent) return { text: "", style: "empty" };
  const mark = agent.queued ? "↻" : agent.running ? "✻" : agent.replayed ? "↺" : agent.ok ? "✓" : "✗";
  const tail = agent.queued ? "queued" : agent.replayed ? "replayed" : formatDuration(agent.durationMs);
  const model = shortModel(agent.model);
  // Queued rows have spent nothing yet, so a number there would be a lie. Running
  // rows show 0 tokens honestly: it says the call has started and nothing is billed.
  const tokens = agent.queued ? "" : `${formatTokens(agent.tokens)} tokens`;

  // The label never goes; the model goes first, then the token count. That is the
  // order a person stops caring in.
  const candidates = [
    `${mark} ${agent.label}  ${model}${model && tokens ? " · " : ""}${tokens}`,
    `${mark} ${agent.label}${tokens ? `  ${tokens}` : ""}`,
    `${mark} ${truncate(agent.label, Math.max(6, width - tail.length - 3))}`,
  ];
  const fit = candidates.find((text) => text.length + tail.length + 1 <= width) ?? candidates.at(-1)!;
  const style: PanelLineStyle = agent.queued
    ? "agent-queued"
    : agent.running
      ? "agent-running"
      : agent.replayed
        ? "agent-replay"
        : agent.ok
          ? "agent-ok"
          : "agent-bad";
  return { text: row(fit, tail, width), style };
}

/** Something running first, then failures, then the expensive ones. */
function sortForPanel(agents: PanelAgentView[]): PanelAgentView[] {
  return [...agents].sort((a, b) => {
    if (a.running !== b.running) return a.running ? -1 : 1;
    if (a.queued !== b.queued) return a.queued ? 1 : -1;
    if (a.ok !== b.ok) return a.ok ? 1 : -1;
    return b.tokens - a.tokens;
  });
}

function agentLines(state: PanelState, job: PanelJobView, width: number): PanelLine[] {
  const sorted = sortForPanel(job.agents.filter((agent) => !agent.queued));
  const agent = sorted[Math.min(state.selectedAgent, Math.max(0, sorted.length - 1))];
  if (!agent) return emptyLines(state);
  const status = agent.replayed ? "replayed" : agent.running ? "running" : agent.ok ? "done" : "failed";
  const lines: PanelLine[] = [
    { text: row(truncate(agent.label, Math.max(10, width - status.length - 2)), status, width), style: "title" },
    { text: `${job.name} · ${shortId(job.id)}${agent.phase ? ` · ${agent.phase}` : ""}`, style: "detail" },
    { text: "", style: "empty" },
  ];
  const facts = [
    ["cost", `${formatTokens(agent.tokens)} tokens`],
    ["time", agent.replayed ? "replayed from the journal" : formatDuration(agent.durationMs)],
    ["model", shortModel(agent.model) || "(the run's model)"],
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
  const answer = answerFor(job, agent.id);
  if (answer) {
    lines.push({ text: "", style: "empty" });
    lines.push({ text: "  answer", style: "title" });
    for (const line of wrap(answer, width - 4).slice(0, 10)) lines.push({ text: `  ${line}`, style: "detail" });
  }
  if (job.scriptHint) {
    lines.push({ text: "", style: "empty" });
    lines.push({ text: `  script ${job.scriptHint}`, style: "hint" });
  }
  lines.push({ text: "", style: "empty" });
  lines.push({ text: "↑↓ agent · esc back", style: "hint" });
  return lines;
}

/** The answer text for an agent, kept on the view for the detail screen. */
function answerFor(job: PanelJobView, id: string): string | undefined {
  return (job as { answers?: Record<string, string> }).answers?.[id];
}

/** Keep the answer texts on the view, so the detail screen needs no job access. */
export function withAnswers(job: PanelJobView, answers: Record<string, string>): PanelJobView {
  return { ...job, answers } as PanelJobView;
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

/** `wf_qhj6qy01` -> `qhj6qy01`, which is the part a person reads. */
function shortId(id: string): string {
  return id.startsWith("wf_") ? id.slice(3) : id;
}

/** Just the numbers, for the one-line status shown after closing the panel. */
export function panelSummary(job: PanelJobView | undefined): string {
  if (!job) return "";
  const tokens = formatTokens(job.tokens);
  if (job.state === "running" || job.state === "queued") {
    return `${job.name} · ${job.done}/${job.planned || "?"} agents · ${tokens} tokens`;
  }
  if (job.state === "paused") return `${job.name} paused · ${job.done} done · ${tokens} tokens`;
  const mark = job.state === "done" ? "✓" : "✗";
  return `${mark} ${job.name} · ${job.done} agents · ${tokens} tokens · ${formatDuration(job.elapsedMs)}`;
}
