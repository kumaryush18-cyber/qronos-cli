// pi prints its own resume hint immediately before process.exit(0) when an
// interactive session ends:
//
//   To resume this session: pi --session <id>
//
// That names `pi`, a binary free-pi-cli users do not have — they installed
// free-pi-cli (usually via npx). pi builds the command from APP_NAME, which
// only a rebranded *pi* package.json (piConfig.name) can change, and the line
// is written straight to stdout with no env-var escape hatch. It also exits
// the process immediately after, so run.ts's own correctly-branded closing
// line can be cut off before it prints.
//
// So we rewrite that one line on its way to the terminal, and leave every
// other byte untouched.

/** The literal prefix pi writes (chalk.dim wraps it, so match on the text, not the bytes). */
const RESUME_LABEL = "To resume this session:";

/**
 * The label, then any mix of ANSI escapes and whitespace (chalk closes its
 * dim styling with `[22m` between the label and the command), then the
 * `pi` command word — bounded by whitespace so a later "pi" in prose is never
 * touched.
 */
const RESUME_COMMAND_RE = /(To resume this session:(?:\u001b\[[0-9;]*m|\s)*)pi(?=\s)( --session-dir (?:'(?:[^']|'\\'')*'|\S+))?/g;

/**
 * Strips OSC 133 shell integration sequences (\x1b]133;A\x07, \x1b]133;B\x07, \x1b]133;C\x07).
 * When running inside web VS Code (Codespaces), xterm.js detects OSC 133;B and 133;C and injects
 * a black horizontal command decoration rule right through the user message's #3a3a3a box.
 * Removing these sequences leaves the user message as a solid, uninterrupted #3a3a3a panel.
 */
const OSC133_RE = /\x1b\]133;[^\x07\x1b]*(\x07|\x1b\\)/g;

/**
 * Rewrites pi's `pi --session <id>` resume command into qronos-cli's
 * equivalent and strips OSC 133 command integration artifacts.
 */
export function rewriteStreamOutput(chunk: string): string {
  let text = chunk;
  if (text.includes(RESUME_LABEL)) {
    text = text.replace(RESUME_COMMAND_RE, "$1qronos-cli");
  }
  if (text.includes("\x1b]133;")) {
    text = text.replace(OSC133_RE, "");
  }
  return text;
}

/** Keep backwards compatible alias */
export const rewriteResumeLine = rewriteStreamOutput;

/** Minimal structural slice of the stream this patches — keeps it testable without a real TTY. */
export interface WritableLike {
  write(chunk: string | Uint8Array, ...rest: unknown[]): boolean;
}

/**
 * Wraps `stream.write` so pi's resume line is rebranded and OSC 133 decoration artifacts are stripped.
 */
export function patchResumeLine(stream: WritableLike): () => void {
  const original = stream.write.bind(stream);
  stream.write = (chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
    if (typeof chunk !== "string") return original(chunk, ...rest);
    return original(rewriteStreamOutput(chunk), ...rest);
  };
  return () => {
    stream.write = original;
  };
}
