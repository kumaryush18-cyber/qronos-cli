// The one-line step name above a shell command, Claude Code style.
//
// Claude Code's Bash tool takes an optional `description` parameter and the
// model fills it with a short active-voice sentence ("List files in current
// directory"). We re-register bash/powershell with that same optional field
// (see tool-aliases.ts) and print it above the command.
//
// The words belong to the model. This module only cleans and cuts them: it
// never invents a step, never throws, and never returns more than one line.

/** Longest step name we draw. Past this the sentence stops being a glance. */
export const STEP_MAX_CHARS = 90;

/** Longest command preview under the step name. */
export const COMMAND_MAX_CHARS = 120;

/**
 * ANSI escapes, both CSI (`\u001b[…m`) and OSC (`\u001b]…\u0007`, used for
 * clickable file links). A model must not be able to inject colour or a link
 * into the transcript through a description.
 */
const ANSI_ESCAPE = /\u001b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\))/g;

/** Control characters that would break the one-line layout. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

/** Cut a string to `max` characters, marking the cut with "...". */
function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}

/**
 * Make any string safe for one transcript line: no colours, no control
 * characters, no runs of spaces, no newlines.
 */
export function cleanLine(value: string, max: number = STEP_MAX_CHARS): string {
  const plain = value.replace(ANSI_ESCAPE, "").replace(CONTROL, " ").replace(/\s+/g, " ").trim();
  return cut(plain, max);
}

/** The first non-empty line of a shell command, cleaned and cut. */
export function commandPreview(command: unknown): string {
  if (typeof command !== "string") return "";
  const first = command
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line !== "");
  if (!first) return "";
  return cleanLine(first, COMMAND_MAX_CHARS);
}

/**
 * The model's step name, or undefined when there is nothing honest to draw.
 *
 * A description identical to the command is dropped: repeating the command
 * above the command tells the user nothing and looks like a bug.
 */
export function stepTitle(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const record = args as Record<string, unknown>;
  const raw = record.description;
  if (typeof raw !== "string") return undefined;
  const title = cleanLine(raw);
  if (title === "") return undefined;
  const command = commandPreview(record.command);
  if (command !== "" && title.toLowerCase() === command.toLowerCase()) return undefined;
  return title;
}

/**
 * The two lines to draw for a shell tool call, or undefined when the model
 * sent no usable description (the caller then keeps its normal layout).
 */
export function stepHeading(args: unknown): { title: string; command: string } | undefined {
  const title = stepTitle(args);
  if (!title || !args || typeof args !== "object") return undefined;
  return { title, command: commandPreview((args as Record<string, unknown>).command) };
}
