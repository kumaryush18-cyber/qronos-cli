// The text you get from `/export`.
//
// Why plain text: a `.txt` file opens everywhere, needs no browser, and is what
// people actually paste into a chat or a bug report. The old `/export` wrote
// HTML or JSONL; those still exist under their old names, but the default is now
// a readable transcript.
//
// Every line here is built from the session entries alone. Nothing is guessed:
// when a field is missing, the line is simply not drawn.
import { cleanLine, commandPreview } from "./tool-step";
import { redactSecrets } from "./secret-redact";

/** A hard cap, so one giant tool result cannot make an unreadable file. */
export const EXPORT_MAX_CHARS = 2_000_000;

/**
 * The cap for this run: `QRONOS_EXPORT_MAX_CHARS`.
 *
 * `0` means no cap at all, for someone who really wants every byte. Anything
 * else is a count of characters, so the limit is never a mystery: the file says
 * on its last line when it was cut.
 */
export function exportMaxChars(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.QRONOS_EXPORT_MAX_CHARS;
  if (raw === undefined || raw.trim() === "") return EXPORT_MAX_CHARS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return EXPORT_MAX_CHARS;
  return value === 0 ? Number.POSITIVE_INFINITY : Math.floor(value);
}
/** How many lines of a tool result are kept. */
const RESULT_MAX_LINES = 20;
/** Width of the rule under the heading. */
const RULE = "─".repeat(56);

/** Anything shaped like a session entry; only `message` entries are read. */
export interface ExportEntryLike {
  type?: string;
  message?: unknown;
}

interface Block {
  type?: string;
  text?: string;
  name?: string;
  arguments?: unknown;
  id?: string;
}

interface MessageLike {
  role?: string;
  content?: unknown;
  toolName?: string;
  isError?: boolean;
}

/** Reduce any text to a safe single line. Colours and control codes go away. */
export function oneLine(value: string, max = 200): string {
  return cleanLine(value, max);
}

/**
 * A slug that is safe on every filesystem.
 *
 * `hi` stays `hi`, `Fix the login bug!` becomes `fix-the-login-bug`. An empty
 * result becomes `conversation`, because a file called `.txt` helps nobody.
 */
export function exportSlug(text: string, max = 30): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
  return slug === "" ? "conversation" : slug;
}

function two(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * The name Claude Code would offer: `2026-11-23-104846-hi.txt`.
 *
 * The date comes first so a folder of exports sorts by time, and the slug comes
 * last so you can still recognise the conversation.
 */
export function exportFileName(now: Date, firstUserText: string): string {
  const date = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
  const time = `${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
  return `${date}-${time}-${exportSlug(firstUserText)}.txt`;
}

/** The first thing the user said, used for the file name. */
export function firstUserText(entries: readonly ExportEntryLike[]): string {
  for (const entry of entries) {
    if (entry?.type !== "message") continue;
    const message = entry.message as MessageLike | undefined;
    if (message?.role !== "user") continue;
    const text = messageText(message.content);
    if (text.trim() !== "") return text;
  }
  return "";
}

/** All readable text of one message content value. */
function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const raw of content) {
    const block = raw as Block;
    if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
    else if (block?.type === "image") parts.push("[image]");
  }
  return parts.join("\n");
}

/** The one argument worth showing for a tool call: a command, or a path. */
function toolArgument(name: string, args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const record = args as Record<string, unknown>;
  const command = commandPreview(record.command ?? record.cmd);
  if (command !== "") return command;
  for (const key of ["file_path", "filePath", "path", "pattern", "query"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") return oneLine(value, 120);
  }
  return "";
}

/**
 * One line for a tool call, in Claude Code's shape: `● Bash(ls -la)`.
 *
 * `bash` and `powershell` are one thing to a reader, so both print as `Bash`.
 */
export function toolCallLine(name: string, args: unknown): string {
  const label = name === "powershell" ? "Bash" : name === "bash" ? "Bash" : name;
  const argument = toolArgument(name, args);
  return argument === "" ? `● ${label}` : `● ${label}(${argument})`;
}

/** The first lines of a tool result, indented under the call. */
function resultLines(message: MessageLike, redact: (text: string) => string): string[] {
  const text = redact(messageText(message.content));
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  if (lines.length === 0) return [];
  const head = message.isError ? "  ⎿  Error: " : "  ⎿  ";
  const kept = lines.slice(0, RESULT_MAX_LINES).map((line, index) =>
    index === 0 ? `${head}${oneLine(line, 200)}` : `     ${oneLine(line, 200)}`,
  );
  if (lines.length > RESULT_MAX_LINES) {
    kept.push(`     … ${lines.length - RESULT_MAX_LINES} more line(s)`);
  }
  return kept;
}

export interface BuildExportTextInput {
  entries: readonly ExportEntryLike[];
  cwd: string;
  /** Model id, when the session knows one. */
  model?: string;
  /** Session name, when one was set. */
  title?: string;
  now: Date;
  /** A seam for the tests; the default is the real redactor. */
  redact?: (text: string) => string;
  /** Character cap; Infinity means no cap. Defaults to `EXPORT_MAX_CHARS`. */
  maxChars?: number;
}

/**
 * The whole transcript as plain text.
 *
 * A message with no text (a thinking-only assistant turn, an empty tool result)
 * adds no lines, so the file never contains blank padding.
 */
export function buildExportText(input: BuildExportTextInput): string {
  const redact = input.redact ?? redactSecrets;
  const out: string[] = [];
  const when = `${input.now.getFullYear()}-${two(input.now.getMonth() + 1)}-${two(input.now.getDate())} ${two(
    input.now.getHours(),
  )}:${two(input.now.getMinutes())}`;

  out.push(`Qronos CLI conversation · ${when}`);
  if (input.title && input.title.trim() !== "") out.push(`Session: ${oneLine(input.title, 120)}`);
  if (input.model && input.model.trim() !== "") out.push(`Model: ${oneLine(input.model, 120)}`);
  out.push(`Working directory: ${input.cwd}`);
  out.push(RULE);
  out.push("");

  for (const entry of input.entries) {
    if (entry?.type === "compaction") {
      out.push("✻ Context compacted");
      out.push("");
      continue;
    }
    if (entry?.type !== "message") continue;
    const message = entry.message as MessageLike | undefined;
    if (!message) continue;

    if (message.role === "user") {
      const text = redact(messageText(message.content)).trim();
      if (text === "") continue;
      out.push(`❯ ${text}`);
      out.push("");
      continue;
    }

    if (message.role === "assistant") {
      const blocks = Array.isArray(message.content) ? (message.content as Block[]) : [];
      for (const block of blocks) {
        if (block?.type === "text" && typeof block.text === "string") {
          const text = redact(block.text).trim();
          if (text === "") continue;
          const lines = text.split("\n");
          out.push(`● ${lines[0]}`);
          for (const line of lines.slice(1)) out.push(line);
          out.push("");
        } else if (block?.type === "toolCall" && typeof block.name === "string") {
          out.push(toolCallLine(block.name, block.arguments));
        }
      }
      continue;
    }

    if (message.role === "toolResult") {
      const lines = resultLines(message, redact);
      out.push(...lines);
      if (lines.length > 0) out.push("");
    }
  }

  let text = out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
  const maxChars = input.maxChars ?? EXPORT_MAX_CHARS;
  if (Number.isFinite(maxChars) && maxChars > 0 && text.length > maxChars) {
    const kept = text.slice(0, maxChars);
    text = `${kept}\n\n… export cut at ${maxChars} characters (QRONOS_EXPORT_MAX_CHARS=0 keeps everything)\n`;
  }
  return text;
}

/**
 * A file name that does not exist yet: collisions get `-2`, `-3`.
 *
 * The same rule as a saved workflow script. A file is never overwritten by
 * accident, because the name the user typed is not the name they meant to lose.
 */
export function freeFileName(name: string, exists: (path: string) => boolean): string {
  if (!exists(name)) return name;
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base}-${index}${ext}`;
    if (!exists(candidate)) return candidate;
  }
  return `${base}-${Date.now()}${ext}`;
}
