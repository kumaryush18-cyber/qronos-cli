// Applying hashline operations to file content.
//
// Pure functions only: this is the part that can corrupt a user's file, so it is
// covered by tests instead of being trusted.
//
// Two rules make the result predictable:
//  1. every op is checked against the file length BEFORE anything is applied,
//     so a patch that half-fits is rejected as a whole;
//  2. ops are applied from the bottom of the file upwards, so earlier line
//     numbers stay valid while later ones are being changed.
import type { PatchOp } from "./parse";

export class PatchApplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PatchApplyError";
  }
}

export interface ApplyResult {
  content: string;
  /** Lines that changed, for the one-line summary the model sees. */
  changedLines: number;
}

interface LineTable {
  lines: string[];
  /** True when the file uses CRLF; the body keeps that ending. */
  crlf: boolean;
  /** True when the file ended with a newline. */
  trailingNewline: boolean;
}

export function splitLines(content: string): LineTable {
  const crlf = content.includes("\r\n");
  const normalized = crlf ? content.replace(/\r\n/g, "\n") : content;
  const trailingNewline = normalized.endsWith("\n");
  const body = trailingNewline ? normalized.slice(0, -1) : normalized;
  const lines = content.length === 0 ? [] : body.split("\n");
  return { lines, crlf, trailingNewline };
}

export function joinLines(table: LineTable): string {
  const text = table.lines.join("\n");
  if (table.lines.length === 0) return "";
  return table.trailingNewline ? `${text}\n` : text;
}

/** Structural ops are handled by the tool (they touch the file system, not text). */
export function applyOps(content: string, ops: readonly PatchOp[]): ApplyResult {
  const textOps = ops.filter((op) => op.kind !== "move" && op.kind !== "remove");
  const table = splitLines(content);
  validate(table.lines.length, textOps);

  // Bottom-up: highest anchor first. Inserts at the very end come before them.
  const ordered = [...textOps].sort((a, b) => anchorOf(b) - anchorOf(a) || rankOf(a) - rankOf(b));

  let changed = 0;
  for (const op of ordered) {
    const body = "body" in op ? op.body : [];
    switch (op.kind) {
      case "replace": {
        table.lines.splice(op.start - 1, op.end - op.start + 1, ...body);
        changed += Math.max(body.length, op.end - op.start + 1);
        break;
      }
      case "cut": {
        table.lines.splice(op.start - 1, op.end - op.start + 1);
        changed += op.end - op.start + 1;
        break;
      }
      case "insert-before": {
        table.lines.splice(op.at - 1, 0, ...body);
        changed += body.length;
        break;
      }
      case "insert-after": {
        table.lines.splice(op.at, 0, ...body);
        changed += body.length;
        break;
      }
      case "append": {
        table.lines.push(...body);
        changed += body.length;
        break;
      }
    }
  }

  const result = { content: joinLines(table), changedLines: changed };
  return table.crlf ? { ...result, content: result.content.replace(/\n/g, "\r\n") } : result;
}

function anchorOf(op: PatchOp): number {
  switch (op.kind) {
    case "replace":
    case "cut":
      return op.end;
    case "insert-before":
      return op.at;
    case "insert-after":
      return op.at + 1;
    case "append":
      return Number.MAX_SAFE_INTEGER;
    default:
      return 0;
  }
}

/** At the same anchor, delete/replace first, then insert, so indexes stay sane. */
function rankOf(op: PatchOp): number {
  switch (op.kind) {
    case "replace":
    case "cut":
      return 0;
    case "insert-after":
      return 1;
    case "insert-before":
      return 2;
    default:
      return 3;
  }
}

/**
 * Reject the whole patch when any op does not fit the file. This is the check
 * that turns "silently truncated file" into "clear error, nothing written".
 */
export function validate(lineCount: number, ops: readonly PatchOp[]): void {
  const ranges: { start: number; end: number }[] = [];

  for (const op of ops) {
    if (op.kind === "replace" || op.kind === "cut") {
      if (op.start > lineCount) {
        throw new PatchApplyError(
          `range ${op.start}.=${op.end} is past the end of the file (${lineCount} lines)`,
        );
      }
      if (op.end > lineCount + 1) {
        throw new PatchApplyError(
          `range ${op.start}.=${op.end} is past the end of the file (${lineCount} lines)`,
        );
      }
      ranges.push({ start: op.start, end: op.end });
    } else if (op.kind === "insert-before") {
      if (op.at < 1 || op.at > lineCount + 1) {
        throw new PatchApplyError(`insert before line ${op.at} is outside 1..${lineCount + 1}`);
      }
    } else if (op.kind === "insert-after") {
      if (op.at < 0 || op.at > lineCount) {
        throw new PatchApplyError(`insert after line ${op.at} is outside 0..${lineCount}`);
      }
    }
  }

  ranges.sort((a, b) => a.start - b.start);
  for (let index = 1; index < ranges.length; index++) {
    if (ranges[index].start <= ranges[index - 1].end) {
      throw new PatchApplyError(
        `ranges ${ranges[index - 1].start}.=${ranges[index - 1].end} and ${ranges[index].start}.=${ranges[index].end} overlap`,
      );
    }
  }
}

/** One-line result summary, e.g. "3 op(s), 12 line(s) changed". */
export function summarize(ops: readonly PatchOp[], changedLines: number): string {
  const kinds = new Map<string, number>();
  for (const op of ops) kinds.set(op.kind, (kinds.get(op.kind) ?? 0) + 1);
  const parts = [...kinds.entries()].map(([kind, count]) => `${count} ${kind}`);
  return `${parts.join(", ")} (${changedLines} line${changedLines === 1 ? "" : "s"} changed)`;
}
