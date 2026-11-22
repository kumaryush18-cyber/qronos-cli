// The scripts you saved, and the way back into them.
//
// `s` in the panel writes a script into `<project>/.qronos/workflows/<name>.js`.
// Saving without a way to run it again is a drawer that only opens one way, so
// this module is the reading half: list them, find one by the name a user would
// type, and read it.
//
// It never writes and never deletes. Overwriting is a decision, and a decision
// belongs to the caller that can ask.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { safeFileName, saveDir } from "./workflow-save";

/** How many scripts the list shows. A wall of names helps nobody. */
export const MAX_SCRIPTS = 20;

export interface SavedScript {
  /** The file name without `.js`, which is what a user types. */
  name: string;
  path: string;
  bytes: number;
  /** When it was last written; absent when the platform will not say. */
  updatedAt?: number;
}

export interface ScriptIo {
  readdir?: (dir: string) => string[];
  stat?: (path: string) => { size: number; mtimeMs: number };
  exists?: (path: string) => boolean;
  read?: (path: string) => string;
}

/**
 * The scripts on disk, newest first.
 *
 * A directory that does not exist is an empty list, not an error: "you have not
 * saved one yet" is a fact, and a crash is not a way to say it.
 */
export function listSavedScripts(dir: string, io: ScriptIo = {}): SavedScript[] {
  const readdir = io.readdir ?? ((path: string) => readdirSync(path));
  const stat = io.stat ?? ((path: string) => statSync(path));
  const exists = io.exists ?? existsSync;
  if (!exists(dir)) return [];

  let names: string[];
  try {
    names = readdir(dir);
  } catch {
    return [];
  }

  const scripts: SavedScript[] = [];
  for (const file of names) {
    if (!file.endsWith(".js")) continue;
    const path = join(dir, file);
    let size = 0;
    let updatedAt: number | undefined;
    try {
      const info = stat(path);
      size = info.size;
      updatedAt = info.mtimeMs;
    } catch {
      // A file that vanished between readdir and stat is simply not listed.
      continue;
    }
    scripts.push({ name: file.slice(0, -3), path, bytes: size, updatedAt });
  }
  return scripts
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || a.name.localeCompare(b.name))
    .slice(0, MAX_SCRIPTS);
}

/**
 * Find the script a word means.
 *
 * Three tries, in order: the exact name, the exact file name, then the safe-slug
 * form (`My Review` and `my-review.js` are the same thing to a person typing).
 * Nothing fuzzy beyond that — guessing which script someone meant is worse than
 * saying "not found" and showing the list.
 */
export function resolveSavedScript(dir: string, word: string, io: ScriptIo = {}): SavedScript | undefined {
  const wanted = word.trim();
  if (wanted === "") return undefined;
  const scripts = listSavedScripts(dir, io);
  const exact = scripts.find((script) => script.name === wanted);
  if (exact) return exact;
  const file = scripts.find((script) => `${script.name}.js` === wanted);
  if (file) return file;
  const slug = safeFileName(wanted, "");
  if (slug === "") return undefined;
  return scripts.find((script) => safeFileName(script.name, "") === slug);
}

/** The text of a script, or undefined when it cannot be read. */
export function readSavedScript(path: string, io: ScriptIo = {}): string | undefined {
  const read = io.read ?? ((target: string) => readFileSync(target, "utf8"));
  try {
    return read(path);
  } catch {
    return undefined;
  }
}

/** What is wrong with a script before it is run, in one short line. */
export function scriptProblem(script: string | undefined): string | undefined {
  if (script === undefined) return "the file could not be read";
  if (script.trim() === "") return "the file is empty";
  return undefined;
}

/** One line about a script: its name, its size, and when it was last written. */
export function savedScriptLine(script: SavedScript, now: number): string {
  const kb = script.bytes < 1024 ? `${script.bytes} B` : `${Math.round(script.bytes / 1024)} KB`;
  const when =
    script.updatedAt === undefined
      ? ""
      : (() => {
          const minutes = Math.round((now - script.updatedAt) / 60_000);
          if (minutes < 1) return "just now";
          if (minutes < 60) return `${minutes}m ago`;
          const hours = Math.round(minutes / 60);
          if (hours < 24) return `${hours}h ago`;
          return `${Math.round(hours / 24)}d ago`;
        })();
  return [script.name, kb, when].filter(Boolean).join(" · ");
}

/** Where the scripts for a project live. One place, so the two sides agree. */
export function scriptDirFor(cwd: string): string {
  return saveDir(cwd);
}
