// Agent Hub, part C: the roster view.
//
// Pure text. No pi-tui, no terminal, no timers — the overlay turns these lines
// into a box with colours, and the tests check them as strings. That keeps the
// fiddly parts (width, truncation, what a row says) testable without a terminal.
//
// Layout is Variant A: a floating panel in the middle of the screen, opened with
// Alt+A or /agents. Approvals stay in the main chat; a row only *says* that an
// agent is waiting, and Enter jumps to it.

import { statusIcon, shortType, formatElapsed, type AgentRecord } from "./agent-registry";

export type HubLineStyle =
  | "title"
  | "row"
  | "row-selected"
  | "row-done"
  | "row-failed"
  | "row-waiting"
  | "detail"
  | "hint"
  | "empty";

export interface HubLine {
  text: string;
  style: HubLineStyle;
}

export interface HubState {
  records: readonly AgentRecord[];
  /** Index into `records`, not an agent id. */
  selected: number;
  /** Terminal width the panel is drawn into. */
  width: number;
  now?: number;
  /** When set, the panel shows this agent's transcript instead of the list. */
  transcriptFor?: AgentRecord;
  /** Text typed so far when steering. */
  steering?: string;
}

/** Inner width: the box costs two columns for its borders. */
function inner(width: number): number {
  return Math.max(20, width - 4);
}

function truncate(text: string, limit: number): string {
  const single = text.replace(/\s+/g, " ").trim();
  if (single.length <= limit) return single;
  return limit <= 1 ? single.slice(0, limit) : `${single.slice(0, limit - 1)}…`;
}

/** Right-align a suffix, padding the left side so rows line up. */
function row(left: string, right: string, width: number): string {
  const space = Math.max(1, width - left.length - right.length);
  return `${left}${" ".repeat(space)}${right}`;
}

function rowStyle(record: AgentRecord): HubLineStyle {
  switch (record.status) {
    case "running":
      return "row";
    case "waiting-approval":
      return "row-waiting";
    case "done":
      return "row-done";
    case "failed":
    case "killed":
      return "row-failed";
    default:
      return "row";
  }
}

function stateWord(record: AgentRecord): string {
  switch (record.status) {
    case "running":
      return record.lastTool ? `running ${record.lastTool}` : "starting";
    case "waiting-approval":
      return "needs approval — answer in the chat";
    case "done":
      return "done";
    case "failed":
      return "failed";
    case "killed":
      return "stopped";
    default:
      return record.status;
  }
}

/** The list panel. */
export function buildHubLines(state: HubState): HubLine[] {
  return clip(buildLines(state), inner(state.width));
}

/** Cut every line to the panel width, so the box border is never broken. */
function clip(lines: HubLine[], width: number): HubLine[] {
  return lines.map((line) =>
    line.text.length <= width ? line : { ...line, text: `${line.text.slice(0, Math.max(0, width - 1))}…` },
  );
}

function buildLines(state: HubState): HubLine[] {
  const width = inner(state.width);
  const now = state.now ?? Date.now();
  const lines: HubLine[] = [];

  if (state.transcriptFor) {
    const record = state.transcriptFor;
    lines.push({
      text: row(`#${record.index} ${truncate(record.description, width - 12)}`, "", width),
      style: "title",
    });
    lines.push({ text: "─".repeat(width), style: "hint" });
    for (const line of transcriptLines(record, width)) lines.push(line);
    lines.push({ text: "─".repeat(width), style: "hint" });
    lines.push({ text: "Esc back · k kill · r revive", style: "hint" });
    return lines;
  }

  const records = state.records;
  const active = records.filter((r) => r.status === "running" || r.status === "waiting-approval").length;
  const title = active > 0 ? `Subagents — ${active} running` : `Subagents — ${records.length} finished`;
  lines.push({ text: row(title, "", width), style: "title" });

  if (records.length === 0) {
    lines.push({ text: "", style: "empty" });
    lines.push({ text: "No subagents in this session.", style: "empty" });
    lines.push({ text: "The model calls the `agent` tool when a task needs one.", style: "hint" });
  }

  for (const [index, record] of records.entries()) {
    const icon = statusIcon(record.status);
    const label = truncate(record.description || "untitled", Math.max(8, width - 30));
    const meta = `${shortType(record.type)} · ${record.turns}/${record.maxTurns} · ${formatElapsed((record.endedAt ?? now) - record.startedAt)}`;
    const selected = index === state.selected;
    lines.push({
      text: row(` ${selected ? "▸" : " "} ${icon} ${record.index}  ${label}`, meta, width),
      style: selected ? "row-selected" : rowStyle(record),
    });
    // One detail line per row: what it is doing, or why it needs you.
    const detail = stateWord(record);
    const detailLine = record.error && (record.status === "failed" || record.status === "killed")
      ? `${detail}: ${record.error}`
      : detail;
    lines.push({ text: `      ${truncate(detailLine, width - 8)}`, style: "detail" });
  }

  if (state.steering !== undefined) {
    lines.push({ text: "", style: "empty" });
    lines.push({ text: `Send to #${records[state.selected]?.index ?? "?"}: ${state.steering}▏`, style: "row-waiting" });
    lines.push({ text: "Enter send · Esc cancel", style: "hint" });
    return lines;
  }

  lines.push({ text: "", style: "empty" });
  lines.push({ text: "↑↓ move · Enter open · s steer · k kill · r revive · Esc close", style: "hint" });
  return lines;
}

/** The transcript panel for one agent. */
export function transcriptLines(record: AgentRecord, width: number): HubLine[] {
  const lines: HubLine[] = [];
  lines.push({ text: `Status: ${stateWord(record)}`, style: record.status === "failed" ? "row-failed" : "detail" });
  lines.push({ text: `Type: ${shortType(record.type)} · turns ${record.turns}/${record.maxTurns}`, style: "detail" });
  lines.push({ text: `Model: ${record.model ?? "(session model)"}`, style: "detail" });
  lines.push({
    text: `Tools: ${record.toolsUsed.length > 0 ? record.toolsUsed.join(", ") : "none yet"}`,
    style: "detail",
  });
  if (record.outputChars !== undefined) {
    lines.push({ text: `Report: ${record.outputChars} characters`, style: "detail" });
  }
  if (record.error) lines.push({ text: `Error: ${record.error}`, style: "row-failed" });

  lines.push({ text: "", style: "empty" });
  lines.push({ text: "Task", style: "title" });
  for (const line of wrap(record.prompt, width)) lines.push({ text: `  ${line}`, style: "detail" });

  if (record.steering?.length) {
    lines.push({ text: "", style: "empty" });
    lines.push({ text: "Your messages", style: "title" });
    for (const message of record.steering) {
      for (const line of wrap(message, width)) lines.push({ text: `  → ${line}`, style: "row-waiting" });
    }
  }
  return lines;
}

/** Wrap on words so a long task does not get cut at the edge. */
export function wrap(text: string, width: number): string[] {
  const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (words.length === 0) return [];
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (current === "") {
      current = word;
    } else if (current.length + 1 + word.length <= width) {
      current = `${current} ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current !== "") lines.push(current);
  return lines;
}

/** Move the selection, clamped to the list. */
export function moveSelection(selected: number, count: number, delta: number): number {
  if (count === 0) return 0;
  const next = selected + delta;
  if (next < 0) return 0;
  if (next >= count) return count - 1;
  return next;
}

/** The one-line status used outside the panel, e.g. after closing it. */
export function hubSummary(records: readonly AgentRecord[]): string {
  const active = records.filter((r) => r.status === "running" || r.status === "waiting-approval");
  const waiting = records.filter((r) => r.status === "waiting-approval").length;
  if (active.length === 0) return "";
  return waiting > 0
    ? `${active.length} agent${active.length === 1 ? "" : "s"} · ${waiting} needs approval`
    : `${active.length} agent${active.length === 1 ? "" : "s"} working`;
}
