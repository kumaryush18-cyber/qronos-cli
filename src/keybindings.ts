// Ctrl+C must not throw away a half-typed prompt.
//
// pi binds Ctrl+C to `app.clear` ("Clear editor") and a fast double press to
// shutdown (InteractiveMode.handleCtrlC). For a terminal coding agent that is
// the wrong default: one accidental Ctrl+C loses a long prompt. Claude Code
// interrupts instead and keeps the text, so qronos ships that binding.
//
// We do not fork pi: pi loads `<agentDir>/keybindings.json` when it builds the
// keybinding manager (KeybindingsManager.create), so we merge our defaults into
// that file before the TUI starts. Keys the user set themselves are never
// touched, and a file we cannot parse is left alone.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** pi accepts one key id, a list of key ids, or [] to disable an action. */
export type KeybindingValue = string | string[];

/**
 * - app.clear: []   Ctrl+C no longer clears the editor.
 *
 * That is the whole change: Ctrl+C is removed and put nowhere else. Escape
 * still interrupts (pi's own default), and Ctrl+D still exits.
 */
export const QRONOS_KEYBINDING_DEFAULTS: Record<string, KeybindingValue> = {
  "app.clear": [],
};

/**
 * Values qronos used to write in earlier builds, with what they should be now.
 * 1.1.0 briefly moved interrupt to Ctrl+C; that is reverted (Escape is enough).
 * Only an exact match is migrated, so a user's own choice is never touched.
 */
export const SUPERSEDED_KEYBINDINGS: Array<{
  action: string;
  was: KeybindingValue;
  now: KeybindingValue;
}> = [{ action: "app.interrupt", was: ["escape", "ctrl+c"], now: ["escape"] }];

export function keybindingsPath(agentDir: string): string {
  return join(agentDir, "keybindings.json");
}

/**
 * Adds the defaults that are missing and rewrites values qronos itself used to
 * write. Pure: returns a copy plus whether anything changed.
 */
export function mergeKeybindingDefaults(
  current: Record<string, unknown> | undefined,
  defaults: Record<string, KeybindingValue> = QRONOS_KEYBINDING_DEFAULTS,
): { config: Record<string, unknown>; changed: boolean } {
  const config: Record<string, unknown> = { ...(current ?? {}) };
  let changed = false;
  for (const { action, was, now } of SUPERSEDED_KEYBINDINGS) {
    if (JSON.stringify(config[action]) !== JSON.stringify(was)) continue;
    config[action] = now;
    changed = true;
  }
  for (const [action, value] of Object.entries(defaults)) {
    if (Object.prototype.hasOwnProperty.call(config, action)) continue;
    config[action] = value;
    changed = true;
  }
  return { config, changed };
}

/**
 * Writes the missing defaults into keybindings.json. Never throws, never
 * rewrites a file it cannot parse. Returns true when the file was written.
 */
export function ensureKeybindingDefaults(agentDir: string): boolean {
  const path = keybindingsPath(agentDir);
  let current: Record<string, unknown> | undefined;
  try {
    if (existsSync(path)) {
      const raw = readFileSync(path, "utf8").trim();
      if (raw !== "") {
        const parsed: unknown = JSON.parse(raw);
        // A keybindings file is always a JSON object; anything else is left alone.
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
        current = parsed as Record<string, unknown>;
      }
    }
  } catch {
    return false;
  }

  const { config, changed } = mergeKeybindingDefaults(current);
  if (!changed) return false;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}
