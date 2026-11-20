// What a subagent did, kept as a small capped log so the Hub can show its own
// chat: the task it was given, its words, every tool it ran, and the result.
//
// Two hard limits, because a subagent can run for ten turns and read large
// files: at most MAX_ITEMS entries and MAX_CHARS characters per entry. The
// oldest entries are dropped first and a marker says how many are hidden, so the
// screen never silently pretends the log is complete.

export type TranscriptKind =
  | "task"
  | "assistant"
  | "thinking"
  | "tool-call"
  | "tool-result"
  | "steer"
  | "error"
  | "notice";

export interface TranscriptItem {
  kind: TranscriptKind;
  text: string;
  /** Tool name, for tool rows. */
  tool?: string;
  /** Tool arguments, already shortened for display. */
  args?: string;
  /** Tool failed. */
  failed?: boolean;
  /** Turn number this item belongs to. */
  turn?: number;
  at: number;
}

export const MAX_ITEMS = 300;
export const MAX_CHARS = 2000;

/** Cut a value to a display-safe one-line string. */
export function clip(text: string, limit = MAX_CHARS): string {
  const single = text.replace(/\r/g, "");
  return single.length <= limit ? single : `${single.slice(0, limit)}… (+${single.length - limit} chars)`;
}

/** Compact tool arguments for one line: `path: src/a.ts, offset: 10`. */
export function formatArgs(args: unknown, limit = 120): string {
  if (args === undefined || args === null) return "";
  if (typeof args === "string") return clip(args.replace(/\s+/g, " "), limit);
  if (typeof args !== "object") return String(args);
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    const shown =
      typeof value === "string"
        ? value.replace(/\s+/g, " ")
        : Array.isArray(value)
          ? `[${value.length}]`
          : typeof value === "object" && value !== null
            ? "{…}"
            : String(value);
    parts.push(`${key}: ${shown.length > 60 ? `${shown.slice(0, 60)}…` : shown}`);
    if (parts.join(", ").length > limit) break;
  }
  const joined = parts.join(", ");
  return joined.length > limit ? `${joined.slice(0, limit)}…` : joined;
}

export class Transcript {
  private items: TranscriptItem[] = [];
  private hidden = 0;

  constructor(private readonly maxItems = MAX_ITEMS) {}

  push(item: Omit<TranscriptItem, "at"> & { at?: number }): void {
    this.items.push({
      ...item,
      text: clip(item.text),
      at: item.at ?? Date.now(),
    });
    while (this.items.length > this.maxItems) {
      this.items.shift();
      this.hidden++;
    }
  }

  /** Append streamed text to the last assistant item, or start one. */
  appendAssistant(delta: string, turn?: number, at = Date.now()): void {
    const last = this.items[this.items.length - 1];
    if (last && last.kind === "assistant" && last.turn === turn) {
      last.text = clip(last.text + delta);
      return;
    }
    this.push({ kind: "assistant", text: delta, turn, at });
  }

  /** Append streamed reasoning to the last thinking item, or start one. */
  appendThinking(delta: string, turn?: number, at = Date.now()): void {
    const last = this.items[this.items.length - 1];
    if (last && last.kind === "thinking" && last.turn === turn) {
      last.text = clip(last.text + delta);
      return;
    }
    this.push({ kind: "thinking", text: delta, turn, at });
  }

  list(): readonly TranscriptItem[] {
    return this.items;
  }

  /** How many old entries were dropped to stay inside the cap. */
  get hiddenCount(): number {
    return this.hidden;
  }

  get size(): number {
    return this.items.length;
  }

  characters(): number {
    return this.items.reduce((total, item) => total + item.text.length, 0);
  }

  clear(): void {
    this.items = [];
    this.hidden = 0;
  }

  /** The newest assistant text, used by the roster row and the summary. */
  lastAssistantText(limit = 300): string {
    for (let index = this.items.length - 1; index >= 0; index--) {
      const item = this.items[index]!;
      if (item.kind === "assistant") return clip(item.text, limit);
    }
    return "";
  }
}
