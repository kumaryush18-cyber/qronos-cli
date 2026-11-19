// One string, used in two places: the OS process name and the window title.
//
// Kept in its own file with no imports because the bin shim (src/index.ts) must
// stay free of heavy modules — it runs before the Node capability guard.
//
// No logo glyph, by request: any extra character is one more thing a font or a
// terminal can render as an empty box. The plain app name is what shows in the
// process list and in the window title.
export const APP_TITLE_TEXT = "Qronos CLI";

/**
 * The escape sequence that names the window/tab, for terminals that do not use
 * the process name.
 *
 * Windows cannot rename a running process (unlike Linux/macOS), so with
 * `npm i -g qronos-cli` a Windows terminal tab reads "node" — that is the real
 * executable behind the `qronos-cli.cmd` shim. Windows Terminal, ConEmu, VS
 * Code with `${sequence}` and most other terminals do follow this escape,
 * which is why it is written by the app itself and not only by pi's UI.
 *
 * OSC 0 sets icon + title, OSC 2 sets the window title; both are sent because
 * terminals honour one or the other. Control characters are stripped so a
 * QRONOS_TITLE value can never inject another escape.
 */
export function terminalTitleSequence(title: string): string {
  const safe = title.replace(/[\u0000-\u001f\u007f]/g, "");
  return `\x1b]0;${safe}\x07\x1b]2;${safe}\x07`;
}
