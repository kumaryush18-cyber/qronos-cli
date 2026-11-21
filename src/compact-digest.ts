// Mechanically extract the facts a summary must not lose.
//
// Why this file exists: a model-written summary is prose, and prose quietly
// drops exact strings — the failing test name, the exit code, the file path.
// Those are exactly the things a later turn needs. So before any model call we
// pull them out with plain code, then hand the list back to the summary
// untouched. No model can lose them, because no model produced them.
import { toolFileArgs } from "./tool-args";

export interface CompactEvidence {
  /** Files touched by tools, in first-seen order, repo-relative where possible. */
  files: string[];
  /** Shell commands that ran, clamped. */
  commands: string[];
  /** Error text seen in tool results, one line each. */
  errors: string[];
  /** Counts, for the status line. */
  stats: { messages: number; toolCalls: number; charsIn: number; charsOut: number };
}

export interface DigestOptions {
  /** Longest single user message kept, in characters. */
  maxUserChars?: number;
  /** Longest assistant text kept, in characters. */
  maxAssistantChars?: number;
  /** Characters kept from the head and the tail of a tool result. */
  toolHeadChars?: number;
  toolTailChars?: number;
  /** Total characters of transcript, hard cap. */
  maxTranscriptChars?: number;
}

const DEFAULTS: Required<DigestOptions> = {
  maxUserChars: 1500,
  maxAssistantChars: 1200,
  toolHeadChars: 400,
  toolTailChars: 300,
  maxTranscriptChars: 36_000,
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    const record = asRecord(block);
    if (!record) continue;
    if (record.type === "text" && typeof record.text === "string") parts.push(record.text);
  }
  return parts.join("\n");
}

/** Clamp from the middle: the head sets the scene, the tail holds the result. */
export function clampMiddle(text: string, head: number, tail: number): string {
  const clean = text.replace(/\r\n/g, "\n").trim();
  if (clean.length <= head + tail) return clean;
  const removed = clean.length - head - tail;
  return `${clean.slice(0, head).trimEnd()}\n… [${removed} chars cut] …\n${clean.slice(-tail).trimStart()}`;
}

/** One line, for a heading or a status line. */
export function firstLine(text: string, max = 120): string {
  const line = text.split("\n").map((part) => part.trim()).find((part) => part !== "") ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function pushUnique(list: string[], value: string): void {
  const clean = value.trim();
  if (!clean || clean.length > 300) return;
  if (!list.includes(clean)) list.push(clean);
}

/** Words that mean "something went wrong". Case-insensitive on purpose. */
const ERROR_WORD = /error|failed|cannot|not found|refused|denied|exception|timeout|unexpected/i;
/** Compiler error codes such as E0432, TS2304, ERR_MODULE_NOT_FOUND. Case-sensitive: "tests" must not match. */
const ERROR_CODE = /E[A-Z]{3,}/;

export function looksLikeErrorLine(line: string): boolean {
  return ERROR_WORD.test(line) || ERROR_CODE.test(line);
}

/** Error-ish lines only: stack traces are noise, the message is not. */
export function errorLines(text: string, max = 3): string[] {
  const found: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    if (!looksLikeErrorLine(line)) continue;
    if (/^\s*at\s/.test(line)) continue; // stack frame
    pushUnique(found, firstLine(line, 200));
    if (found.length >= max) break;
  }
  return found;
}

export interface PrunedTurn {
  role: "user" | "assistant" | "tool" | "other";
  label: string;
  text: string;
}

/**
 * Turn raw session messages into a bounded, readable transcript.
 *
 * This is the pruning step: a 30k-token tool dump becomes 700 characters, so
 * the summarizer reads the shape of the work instead of drowning in it.
 */
export function pruneMessages(messages: unknown[], options: DigestOptions = {}): PrunedTurn[] {
  const opts = { ...DEFAULTS, ...options };
  const turns: PrunedTurn[] = [];

  for (const message of messages) {
    const record = asRecord(message);
    if (!record) continue;
    const role = record.role;

    if (role === "user") {
      const text = textOfContent(record.content);
      if (text.trim()) turns.push({ role: "user", label: "USER", text: clampMiddle(text, opts.maxUserChars, 200) });
      continue;
    }

    if (role === "assistant") {
      const text = textOfContent(record.content);
      const calls = Array.isArray(record.content)
        ? record.content
            .map(asRecord)
            .filter((block): block is Record<string, unknown> => !!block && block.type === "toolCall")
        : [];
      if (text.trim()) {
        turns.push({ role: "assistant", label: "ASSISTANT", text: clampMiddle(text, opts.maxAssistantChars, 200) });
      }
      for (const call of calls) {
        const name = typeof call.name === "string" ? call.name : "tool";
        const args = call.arguments ?? call.args ?? {};
        turns.push({
          role: "tool",
          label: `CALL ${name}`,
          text: clampMiddle(JSON.stringify(args), 200, 200),
        });
      }
      continue;
    }

    if (role === "toolResult" || role === "tool") {
      const name = typeof record.toolName === "string" ? record.toolName : "tool";
      const text = textOfContent(record.content) || (typeof record.output === "string" ? record.output : "");
      const isError = record.isError === true;
      turns.push({
        role: "tool",
        label: `RESULT ${name}${isError ? " (error)" : ""}`,
        text: clampMiddle(text, opts.toolHeadChars, opts.toolTailChars),
      });
      continue;
    }

    const text = textOfContent(record.content);
    if (text.trim()) turns.push({ role: "other", label: String(role ?? "other").toUpperCase(), text: clampMiddle(text, 400, 200) });
  }

  // Hard cap: keep the newest turns, because the next turn continues from them.
  let total = 0;
  const kept: PrunedTurn[] = [];
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index]!;
    const size = turn.text.length + turn.label.length + 4;
    if (total + size > opts.maxTranscriptChars && kept.length > 0) break;
    total += size;
    kept.unshift(turn);
  }
  return kept;
}

export function renderTranscript(turns: PrunedTurn[]): string {
  return turns.map((turn) => `${turn.label}:\n${turn.text}`).join("\n\n");
}

/** Paths, commands and errors, pulled out with code rather than by a model. */
export function extractEvidence(messages: unknown[], cwd?: string): CompactEvidence {
  const files: string[] = [];
  const commands: string[] = [];
  const errors: string[] = [];
  let toolCalls = 0;
  let charsIn = 0;
  let charsOut = 0;

  for (const message of messages) {
    const record = asRecord(message);
    if (!record) continue;
    charsIn += JSON.stringify(record).length;

    if (record.role === "assistant" && Array.isArray(record.content)) {
      for (const block of record.content) {
        const call = asRecord(block);
        if (!call || call.type !== "toolCall") continue;
        toolCalls += 1;
        const args = call.arguments ?? call.args;
        for (const path of toolFileArgs(args)) pushUnique(files, relativise(path, cwd));
        const command = asRecord(args)?.command;
        if (typeof command === "string") pushUnique(commands, firstLine(command, 200));
      }
    }

    if (record.role === "toolResult" || record.role === "tool") {
      const text = textOfContent(record.content) || (typeof record.output === "string" ? record.output : "");
      charsOut += text.length;
      if (record.isError === true) for (const line of errorLines(text)) pushUnique(errors, line);
      // A result body often carries the only copy of a compiler error.
      for (const line of errorLines(text, 1)) pushUnique(errors, line);
    }
  }

  return {
    files: files.slice(0, 24),
    commands: commands.slice(0, 16),
    errors: errors.slice(0, 12),
    stats: { messages: messages.length, toolCalls, charsIn, charsOut },
  };
}

/** Keep a path short and stable: relative to the session cwd when it is inside it. */
export function relativise(path: string, cwd?: string): string {
  const clean = path.trim().replace(/\\/g, "/");
  if (!cwd) return clean;
  const base = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  if (base && clean.startsWith(`${base}/`)) return clean.slice(base.length + 1);
  return clean;
}

/** The block appended to every summary verbatim. Empty when there is nothing. */
export function renderEvidence(evidence: CompactEvidence): string {
  const parts: string[] = [];
  if (evidence.files.length > 0) parts.push(`Files touched:\n${evidence.files.map((file) => `- ${file}`).join("\n")}`);
  if (evidence.commands.length > 0) {
    parts.push(`Commands run:\n${evidence.commands.map((command) => `- \`${command}\``).join("\n")}`);
  }
  if (evidence.errors.length > 0) parts.push(`Errors seen:\n${evidence.errors.map((error) => `- ${error}`).join("\n")}`);
  if (parts.length === 0) return "";
  return `## Exact Evidence (recorded by the tool layer, not paraphrased)\n${parts.join("\n\n")}`;
}

export function evidenceLine(evidence: CompactEvidence): string {
  const bits: string[] = [];
  if (evidence.files.length > 0) bits.push(`${evidence.files.length} file(s)`);
  if (evidence.commands.length > 0) bits.push(`${evidence.commands.length} command(s)`);
  if (evidence.errors.length > 0) bits.push(`${evidence.errors.length} error(s)`);
  return bits.join(", ");
}
