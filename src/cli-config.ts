// #37 U1 / R5: read-only opt-out config. Never creates or writes the file —
// the default (autoUpdate on) needs no state on disk, only an owner-set
// `{"autoUpdate":false}` does. Fails open to `true` on any read/parse error
// so a broken config file can never silently disable the version check's
// safety net.
//
// Execution-mode persistence reuses the same file. Unlike autoUpdate, the mode
// is user-owned state written by the CLI itself, so writeConfigPatch() is
// allowed to create the file — but it stays best-effort: a read-only HOME or a
// corrupt file must never break startup, so every write failure is swallowed
// and the in-memory mode simply wins for that session.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

type ConfigRecord = Record<string, unknown>;

export function readConfigObject(configPath: string): ConfigRecord | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as ConfigRecord;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function readAutoUpdate(configPath: string): boolean {
  const parsed = readConfigObject(configPath);
  if (!parsed) return true;
  return parsed.autoUpdate !== false;
}

export function readStatusLineCommand(configPath: string): string | undefined {
  const parsed = readConfigObject(configPath);
  if (!parsed || typeof parsed.statusLine !== "string") return undefined;
  const cmd = parsed.statusLine.trim();
  return cmd.length > 0 ? cmd : undefined;
}

/**
 * Merge a shallow patch into the config file, preserving unrelated keys.
 * Best-effort: returns false instead of throwing when the file cannot be
 * written (read-only HOME, permissions, corrupt JSON we refuse to clobber).
 */
export function writeConfigPatch(configPath: string, patch: ConfigRecord): boolean {
  try {
    const existing = readFileSync(configPath, "utf8");
    // A corrupt file is left alone rather than silently overwritten — losing an
    // owner's hand-edited config is worse than a session that forgets its mode.
    let current: ConfigRecord;
    try {
      const parsed: unknown = JSON.parse(existing);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
      current = parsed as ConfigRecord;
    } catch {
      return false;
    }
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, `${JSON.stringify({ ...current, ...patch }, null, 2)}\n`, "utf8");
    return true;
  } catch (err) {
    // ENOENT: file does not exist yet, which is the common first-run case.
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      try {
        mkdirSync(dirname(configPath), { recursive: true });
        writeFileSync(configPath, `${JSON.stringify(patch, null, 2)}\n`, "utf8");
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
}

/**
 * Read a hooks file and parse it into a HookConfig. Missing or corrupt files
 * yield an empty config rather than throwing: a broken hooks.json must never
 * stop the CLI from starting. Loader is separate from the parser so tests can
 * exercise both halves independently.
 */
export function readHooksFile(configPath: string): Record<string, unknown> {
  const parsed = readConfigObject(configPath);
  if (!parsed) return {};
  return parsed;
}
