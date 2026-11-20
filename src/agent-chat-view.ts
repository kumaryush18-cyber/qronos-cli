// Agent Hub, part E: one subagent's own chat.
//
// Pure text, like the roster view: the overlay adds colours and keys, the tests
// read strings. The screen shows what the main chat shows for the parent agent —
// the task it was given, its words, each tool it ran with its result — because a
// subagent is only trusted when you can see what it did.
//
// Long answers scroll: a window of `height` lines is taken from the end
// (following new output) unless the user scrolled up, and the footer says so.

import type { AgentRecord } from "./agent-registry";
import type { TranscriptItem } from "./agent-transcript";
import { formatElapsed, shortType } from "./agent-registry";

export type ChatLineStyle =
  | "header"
  | "rule"
  | "label"
  | "text"
  | "dim"
  | "tool"
  | "tool-ok"
  | "tool-fail"
  | "steer"
  | "error"
  | "notice"
  | "hint";

export interface ChatLine {
  text: string;
  style: ChatLineStyle;
}

export interface ChatState {
  record: AgentRecord;
  /** Full panel width. */
  width: number;
  /** How many body lines fit. The header and footer are extra. */
  height: number;
  /** Lines scrolled up from the bottom. 0 = following new output. */
  scrollBack?: number;
  now?: number;
}

/** Inner width: borders cost two columns, one more each side is breathing room. */
function inner(width: number): number {
  return Math.max(16, width - 4);
}

function cut(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return limit <= 1 ? text.slice(0, limit) : `${text.slice(0, limit - 1)}…`;
}

/** Wrap a paragraph on words. */
export function wrap(text: string, width: number): string[] {
  const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (words.length === 0) return [];
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    // A single word longer than the line is split, not left to overflow.
    if (word.length > width) {
      if (current !== "") {
        lines.push(current);
        current = "";
      }
      for (let index = 0; index < word.length; index += width) lines.push(word.slice(index, index + width));
      continue;
    }
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

function statusWord(record: AgentRecord): string {
  switch (record.status) {
    case "running":
      return record.retrying ? `retrying (${record.retrying.attempt}/${record.retrying.maxAttempts})` : "running";
    case "waiting-approval":
      return "waiting for approval";
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

/** One tool row: `● read  path: src/a.ts` then `  ✓ 128 lines`. */
function toolLines(item: TranscriptItem, width: number): ChatLine[] {
  const name = item.tool ?? item.text;
  const args = item.args ? `  ${item.args}` : "";
  const lines: ChatLine[] = [];
  if (item.kind === "tool-call") {
    lines.push({ text: cut(` ● ${name}${args}`, width), style: "tool" });
    return lines;
  }
  const first = (item.text || "done").split("\n")[0] ?? "";
  const mark = item.failed ? " ✗ " : " ✓ ";
  const body = wrap(first, Math.max(8, width - 4));
  lines.push({ text: cut(`${mark}${body[0] ?? ""}`, width), style: item.failed ? "tool-fail" : "tool-ok" });
  for (const extra of body.slice(1, 3)) {
    lines.push({ text: cut(`   ${extra}`, width), style: item.failed ? "tool-fail" : "tool-ok" });
  }
  return lines;
}

/** The whole log as lines, before scrolling. */
export function buildChatBody(record: AgentRecord, width: number): ChatLine[] {
  const bodyWidth = inner(width);
  const items = record.transcript?.list() ?? [];
  const hidden = record.transcript?.hiddenCount ?? 0;
  const lines: ChatLine[] = [];

  if (hidden > 0) {
    lines.push({ text: `… ${hidden} earlier lines hidden`, style: "dim" });
  }
  if (items.length === 0) {
    lines.push({ text: "Nothing recorded yet.", style: "dim" });
    return lines;
  }

  for (const item of items) {
    switch (item.kind) {
      case "task": {
        lines.push({ text: "Task from the main agent", style: "label" });
        for (const line of wrap(item.text, bodyWidth)) lines.push({ text: `  ${line}`, style: "text" });
        lines.push({ text: "", style: "text" });
        break;
      }
      case "assistant": {
        const parts = item.text.split("\n");
        lines.push({ text: "✻ Subagent", style: "label" });
        for (const part of parts) {
          for (const line of wrap(part, bodyWidth)) lines.push({ text: `  ${line}`, style: "text" });
        }
        lines.push({ text: "", style: "text" });
        break;
      }
      case "thinking": {
        // Reasoning is kept but collapsed: one dim line, so the chat stays readable.
        lines.push({ text: `  ⋯ reasoned ${item.text.length} characters`, style: "dim" });
        break;
      }
      case "tool-call":
      case "tool-result": {
        lines.push(...toolLines(item, bodyWidth));
        break;
      }
      case "steer": {
        for (const line of wrap(item.text, Math.max(8, bodyWidth - 4))) {
          lines.push({ text: ` → you: ${line}`, style: "steer" });
        }
        break;
      }
      case "notice": {
        for (const line of wrap(item.text, bodyWidth)) lines.push({ text: `  ${line}`, style: "notice" });
        break;
      }
      case "error": {
        for (const line of wrap(item.text, bodyWidth)) lines.push({ text: `  ${line}`, style: "error" });
        break;
      }
    }
  }
  return lines;
}

/** Header + window + footer. This is what the panel draws. */
export function buildChatLines(state: ChatState): ChatLine[] {
  const { record, width } = state;
  const now = state.now ?? Date.now();
  const bodyWidth = inner(width);
  const height = Math.max(3, state.height);

  const elapsed = formatElapsed((record.endedAt ?? now) - record.startedAt);
  const title = `#${record.index} ${record.description || record.type}`;
  const meta = `${shortType(record.type)} · ${statusWord(record)} · ${record.turns}/${record.maxTurns} · ${elapsed}`;

  const body = buildChatBody(record, width);
  const scrollBack = Math.max(0, Math.min(state.scrollBack ?? 0, Math.max(0, body.length - height)));
  const start = Math.max(0, body.length - height - scrollBack);
  const window = body.slice(start, start + height);

  const out: ChatLine[] = [];
  out.push({ text: cut(title, bodyWidth), style: "header" });
  out.push({ text: cut(`  ${meta}`, bodyWidth), style: "header" });
  out.push({ text: "─".repeat(bodyWidth), style: "rule" });
  for (const line of window) out.push(line);
  // Keep the footer at a fixed place even when the log is short.
  for (let pad = window.length; pad < height; pad++) out.push({ text: "", style: "text" });
  out.push({ text: "─".repeat(bodyWidth), style: "rule" });

  if (record.status === "waiting-approval") {
    out.push({ text: cut("? needs approval — answer in the main chat", bodyWidth), style: "notice" });
  } else if (record.retrying) {
    const seconds = Math.round(record.retrying.delayMs / 1000);
    out.push({
      text: cut(`✻ retrying in ${seconds}s · attempt ${record.retrying.attempt}/${record.retrying.maxAttempts}`, bodyWidth),
      style: "notice",
    });
  }

  const hint =
    scrollBack > 0
      ? `↑↓ scroll · End follow · Esc back · s steer · k kill`
      : `Esc back · PgUp scroll · s steer · k kill`;
  out.push({ text: cut(hint, bodyWidth), style: "hint" });
  return out;
}

/** How far the log can scroll back, given the window. */
export function maxScroll(record: AgentRecord, width: number, height: number): number {
  const body = buildChatBody(record, width);
  return Math.max(0, body.length - Math.max(3, height));
}

/** Move the scroll offset the way a reader expects. */
export function moveScroll(current: number, limit: number, delta: number): number {
  const next = current + delta;
  if (next <= 0) return 0;
  if (next >= limit) return limit;
  return next;
}
