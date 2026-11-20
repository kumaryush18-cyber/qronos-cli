/**
 * Terminal feel defaults that Qronos CLI wants on every machine.
 *
 * `settings.json` belongs to the user, so this never overwrites a value: it only
 * adds the keys that are missing. Two of them matter for scrolling:
 *
 *   fullscreenScrollbar        "always" draws the right-hand bar, so it is
 *                              obvious where you are in a long answer.
 *   fullscreenWheelScrollLines 1 moves one line per wheel notch. The default is
 *                              "auto", which accelerates a fast spin to six
 *                              lines per event on Windows and Linux, and that is
 *                              what makes scrolling feel like it jumps in blocks.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { getQronosAgentDir } from "./paths";

export const UI_DEFAULTS: Readonly<Record<string, unknown>> = {
  fullscreenScrollbar: "always",
  fullscreenWheelScrollLines: 1,
};

export function settingsPath(agentDir: string = getQronosAgentDir()): string {
  return join(agentDir, "settings.json");
}

/**
 * Smooth scrolling is Qronos CLI's job, not the user's.
 *
 * pi resolves the wheel step from settings and falls back to "auto", which turns
 * a fast spin into six-line jumps on Windows and Linux. Patching the resolver
 * keeps the behaviour ours: "auto" becomes exactly one line per notch, while a
 * number the user typed themselves (3, 5, ...) is left alone, so nobody is locked
 * out of their own preference.
 */
export function installSmoothScrolling(): void {
  const proto = SettingsManager.prototype as unknown as {
    getFullscreenWheelScrollLines: () => unknown;
    getFullscreenScrollbar: () => unknown;
  };
  const originalLines = proto.getFullscreenWheelScrollLines;
  const originalBar = proto.getFullscreenScrollbar;

  proto.getFullscreenWheelScrollLines = function patchedWheelLines(this: unknown) {
    const value = originalLines.call(this);
    return value === "auto" ? 1 : value;
  };
  proto.getFullscreenScrollbar = function patchedScrollbar(this: unknown) {
    const value = originalBar.call(this);
    return value === undefined || value === "auto" || value === "hidden" ? "always" : value;
  };
}

/** Merge the missing keys into `settings.json`. Returns true when the file changed. */
export function ensureUiDefaults(agentDir: string = getQronosAgentDir()): boolean {
  const path = settingsPath(agentDir);
  let current: Record<string, unknown> = {};
  try {
    if (existsSync(path)) {
      const raw = readFileSync(path, "utf8").trim();
      if (raw !== "") {
        const parsed: unknown = JSON.parse(raw);
        // A settings file is always a JSON object; anything else is left alone.
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
        current = parsed as Record<string, unknown>;
      }
    }
  } catch {
    return false;
  }

  let changed = false;
  for (const [key, value] of Object.entries(UI_DEFAULTS)) {
    if (current[key] === undefined) {
      current[key] = value;
      changed = true;
    }
  }
  if (!changed) return false;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(current, null, 2)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}
