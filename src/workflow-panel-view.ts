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
import { formatTokens, type WorkflowAgentActivity, type WorkflowUsage } from "./workflow-types";
import type { WorkflowJob } from "./workflow-jobs";
import { formatDuration } from "./workflow-glyphs";
import { modelWithContext } from "./workflow-context-size";

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
  /** How much room that model had: 1 000 000 draws as `[1m]`. */
  contextWindow?: number;
  /** True when this agent was run again from the detail view. */
  restarted?: boolean;
  /** How many times this agent was run again, after the first time. */
  attempts?: number;
  /** True when the last restart used words the user edited. */
  editedPrompt?: boolean;
  /** The task it was given, redacted and capped. */
  prompt?: string;
  /** The last few tool calls, newest last. */
  activity?: WorkflowAgentActivity[];
  /** Every tool call it made, including the ones past the kept rows. */
  toolCalls?: number;
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
  /** Which block the cursor is on in the detail view: 0 prompt, 1 activity, 2 outcome. */
  selectedBlock?: number;
  /** Blocks the user opened with `enter`. Closed by default: a prompt is long. */
  expanded?: { prompt?: boolean; activity?: boolean; outcome?: boolean };
}

/** The blocks of the detail view, in the order they appear. */
export const DETAIL_BLOCKS = ["prompt", "activity", "outcome"] as const;

/** How much of a prompt or an answer is shown before `enter` is pressed. */
const PREVIEW_LINES = 2;
/** How many activity rows show while the block is closed. */
const PREVIEW_ACTIVITY = 3;
/** Ceiling once a block is open, so one long prompt cannot push the keys away. */
const EXPANDED_LINES = 12;

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
    contextWindow: agent.contextWindow,
    restarted: agent.restarted,
    attempts: agent.attempts?.length ?? 0,
    editedPrompt: agent.attempts?.at(-1)?.prompt !== undefined,
    prompt: agent.prompt,
    activity: agent.activity,
    toolCalls: agent.toolCalls,
  })) as PanelAgentView[];

  // `agents` only holds finished ones, so the ones still working come from the
  // live map the manager keeps. They get a row too: a panel that shows nothing
  // until an agent finishes looks broken exactly when you most want to look.
  //
  // Reading the map instead of the event window matters: sixteen agents making
  // forty tool calls each would push every `agent_start` out of a sixty-line
  // window, and the panel would go blank while the run is busiest.
  const live = job.live ?? new Map();
  for (const entry of live.values()) {
    agents.push({
      id: entry.id,
      label: entry.label,
      ok: false,
      replayed: false,
      tokens: 0,
      // A real `agent_start` carries a real timestamp; clamp to a day, so a bad
      // clock cannot print a silly number.
      durationMs: Math.min(86_400_000, Math.max(0, now - entry.startedAt)),
      phase: entry.phase,
      depth: 1,
      running: true,
      queued: false,
      model: entry.model,
      prompt: entry.prompt,
      activity: entry.activity,
      toolCalls: entry.toolCalls,
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

/**
 * One agent, in full: the list of agents on the left, its story on the right.
 *
 * The left column stays, because orientation matters: after reading a long
 * prompt you still want to know which agent you are reading about and what the
 * others are doing. Closing the detail returns to the phases, never to nothing.
 */
function agentLines(state: PanelState, job: PanelJobView, width: number): PanelLine[] {
  const phase = job.phases[Math.min(state.selectedPhase, Math.max(0, job.phases.length - 1))];
  // Queued agents have nothing to show yet, so the detail list leaves them out:
  // an arrow key that lands on "waiting" and shows an empty screen is a trap.
  const list = (phase ? agentsIn(job, phase.name) : sortForPanel(job.agents)).filter((agent) => !agent.queued);
  const index = Math.min(state.selectedAgent, Math.max(0, list.length - 1));
  const agent = list[index];
  if (!agent) return emptyLines(state);

  const { left, right: rightWidth } = columnWidths(state.width);
  const detail = detailLines(state, agent, job, rightWidth);
  const rows = Math.max(list.length, detail.length);

  const lines: PanelLine[] = [];
  lines.push({
    text: row(
      truncate(phase ? `Agents · ${phase.name}` : "Agents", left),
      row(truncate(agent.label, Math.max(8, rightWidth - 12)), statusWord(agent), rightWidth),
      width,
    ),
    style: "column-head",
  });

  for (let rowIndex = 0; rowIndex < rows; rowIndex += 1) {
    const entry = list[rowIndex];
    const chosen = rowIndex === index;
    const leftCell = entry ? `${chosen ? "▸" : " "} ${agentMark(entry)} ${truncate(entry.label, Math.max(6, left - 5))}` : "";
    const right = detail[rowIndex];
    lines.push({
      text: `${leftCell.padEnd(left)}│ ${right ? right.text : ""}`,
      // The chosen agent's name is the one thing that must be obvious.
      style: right ? right.style : chosen ? "phase-selected" : "detail",
    });
  }

  const hidden = list.length - Math.min(list.length, rows);
  if (hidden > 0) lines.push({ text: `  … ${hidden} more agents in ${phase?.name ?? "this run"}`, style: "detail" });

  lines.push({ text: "", style: "empty" });
  lines.push({
    text: truncate("↑↓ agent · tab block · enter expand · r rerun · p/x/s · esc back", width),
    style: "hint",
  });
  return lines;
}

/** The mark that says what an agent is doing, in one cell. */
function agentMark(agent: PanelAgentView): string {
  if (agent.queued) return "↻";
  if (agent.running) return "●";
  if (agent.replayed) return "↺";
  return agent.ok ? "✓" : "✗";
}

/** The word next to the status dot: what Claude Code prints after `●`. */
function statusWord(agent: PanelAgentView): string {
  const dot = agentMark(agent);
  if (agent.queued) return `${dot} Queued`;
  if (agent.running) return `${dot} Running`;
  if (agent.replayed) return `${dot} Replayed`;
  // "Done · restarted" says two things at once: the answer is new, and it cost
  // tokens a second time. A plain Done would hide the second charge.
  if (agent.restarted) return agent.ok ? `${dot} Done · restarted` : `${dot} Failed · restarted`;
  return agent.ok ? `${dot} Done` : `${dot} Failed`;
}

/** How long the agent has been quiet, counted from its last tool call. */
function idleFor(agent: PanelAgentView, now: number): number {
  const last = agent.activity?.at(-1)?.at;
  const startedAt = now - agent.durationMs;
  return Math.min(86_400_000, Math.max(0, now - (last ?? startedAt)));
}

/** The right-hand column of the detail view, as plain rows. */
function detailLines(state: PanelState, agent: PanelAgentView, job: PanelJobView, width: number): PanelLine[] {
  const lines: PanelLine[] = [];
  const cursor = state.selectedBlock ?? 0;
  const open = state.expanded ?? {};
  // The size sits beside the name, as in Claude Code: it says at a glance whether
  // this agent had room to read the file it was asked about.
  const model = modelWithContext(shortModel(agent.model), agent.contextWindow) || "model not recorded";
  const tokens = `${formatTokens(agent.tokens)} tokens`;
  const tools = agent.toolCalls === undefined ? "" : `${agent.toolCalls} tool${agent.toolCalls === 1 ? "" : "s"}`;
  const facts = [tokens, tools, agent.running ? `idle ${formatDuration(idleFor(agent, state.now))}` : `took ${formatDuration(agent.durationMs)}`]
    .filter(Boolean)
    .join(" · ");
  lines.push({ text: truncate(model, width), style: "detail" });
  lines.push({ text: truncate(facts, width), style: "detail" });
  if (agent.depth > 1) lines.push({ text: `nested, level ${agent.depth}`, style: "detail" });
  if (agent.attempts !== undefined && agent.attempts > 0) {
    const tries = agent.attempts + 1;
    lines.push({
      text: truncate(`attempt ${tries} · ran again ${agent.attempts} time${agent.attempts === 1 ? "" : "s"}`, width),
      style: "detail",
    });
  }
  lines.push({ text: "", style: "empty" });

  // --- Prompt ---------------------------------------------------------------
  const prompt = agent.prompt ?? "";
  const promptLines = prompt === "" ? [] : wrap(prompt, width - 2);
  lines.push({
    text: blockHead(
      "Prompt",
      promptLines.length === 0
        ? "not kept"
        : `${promptLines.length} line${promptLines.length === 1 ? "" : "s"}${agent.editedPrompt ? " · edited" : ""}`,
      cursor === 0,
      open.prompt === true,
      promptLines.length > PREVIEW_LINES,
    ),
    style: cursor === 0 ? "phase-selected" : "detail",
  });
  const shownPrompt = open.prompt ? promptLines.slice(0, EXPANDED_LINES) : promptLines.slice(0, PREVIEW_LINES);
  for (const line of shownPrompt) lines.push({ text: `  ${line}`, style: "detail" });
  const hiddenPrompt = promptLines.length - shownPrompt.length;
  if (hiddenPrompt > 0) lines.push({ text: `  … ${hiddenPrompt} more line${hiddenPrompt === 1 ? "" : "s"}`, style: "hint" });
  lines.push({ text: "", style: "empty" });

  // --- Activity -------------------------------------------------------------
  const activity = agent.activity ?? [];
  const total = agent.toolCalls ?? activity.length;
  const activityDetail =
    total === 0
      ? "no tool calls"
      : `last ${Math.min(activity.length, PREVIEW_ACTIVITY)} of ${total}`;
  lines.push({
    text: blockHead("Activity", activityDetail, cursor === 1, open.activity === true, activity.length > PREVIEW_ACTIVITY),
    style: cursor === 1 ? "phase-selected" : "detail",
  });
  const shownActivity = open.activity ? activity.slice(-EXPANDED_LINES) : activity.slice(-PREVIEW_ACTIVITY);
  for (const [position, rowActivity] of shownActivity.entries()) {
    const isLast = position === shownActivity.length - 1;
    const call = `${rowActivity.tool}${rowActivity.detail ? `(${rowActivity.detail})` : ""}`;
    // The newest call is the one a person is waiting on; while it is the last
    // thing the agent did and the agent is still running, it is what it is doing.
    const marker = agent.running && isLast ? " · now" : "";
    lines.push({ text: truncate(`  ${call}${marker}`, width), style: agent.running && isLast ? "agent-running" : "detail" });
  }
  lines.push({ text: "", style: "empty" });

  // --- Outcome --------------------------------------------------------------
  const answer = answerFor(job, agent.id);
  const outcomeLines = agent.running
    ? 1
    : agent.error
      ? wrap(agent.error, width - 2).length
      : answer
        ? wrap(answer, width - 2).length
        : 1;
  lines.push({
    text: blockHead("Outcome", "", cursor === 2, open.outcome === true, outcomeLines > PREVIEW_LINES),
    style: cursor === 2 ? "phase-selected" : "detail",
  });
  if (agent.running) {
    lines.push({ text: "  Still running…", style: "agent-running" });
  } else if (agent.error) {
    for (const line of bodyLines(agent.error, open.outcome === true)) {
      lines.push({ text: `  ${line}`, style: "agent-bad" });
    }
  } else if (answer) {
    for (const line of bodyLines(answer, open.outcome === true)) {
      lines.push({ text: `  ${line}`, style: "detail" });
    }
  } else {
    lines.push({ text: "  (the answer was not kept for this run)", style: "hint" });
  }
  return lines;

  /** Two lines of a block, or twelve when it is open, each cut to the column. */
  function bodyLines(text: string, open: boolean): string[] {
    const wrapped = wrap(text, width - 2);
    const shown = wrapped.slice(0, open ? EXPANDED_LINES : PREVIEW_LINES);
    const more = wrapped.length - shown.length;
    if (more > 0) shown.push(`… ${more} more line${more === 1 ? "" : "s"}${open ? "" : " · enter expand"}`);
    return shown;
  }
}

/**
 * `▸ Prompt · 7 lines · ↵ expand`, with the cursor mark when it is selected.
 *
 * `expandable` is what makes the hint honest: a one-line prompt has nothing to
 * open, so it does not offer to open it.
 */
function blockHead(label: string, detail: string, selected: boolean, open: boolean, expandable: boolean): string {
  const middle = detail === "" ? "" : ` · ${detail}`;
  const hint = expandable ? ` · ↵ ${open ? "collapse" : "expand"}` : "";
  return `${selected ? "▸" : " "} ${label}${middle}${hint}`;
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
