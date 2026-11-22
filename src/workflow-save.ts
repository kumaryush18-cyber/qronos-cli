// Saving a workflow script, so a good run can be used again tomorrow.
//
// Claude Code's panel has "s to save" and a `/workflows` command that does the
// same thing, and it is worth copying: a workflow that worked is worth keeping,
// and a script that only lives in a chat log is gone by lunch.
//
// Where it goes: `<project>/.qronos/workflows/<name>.js`. Inside the project, so
// `git add` can keep it, and next to the code it describes. Nothing is written
// until `s` (or `/workflows save`) is pressed, and an existing file is never
// silently replaced: the new one gets `-2`, `-3`, and so on.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Where saved scripts live for a project. */
export function saveDir(cwd: string): string {
  return join(cwd, ".qronos", "workflows");
}

/**
 * A file name from a workflow name.
 *
 * Only `a-z`, `0-9` and `-` survive, so the name is safe on every filesystem and
 * in a shell. An empty result becomes `workflow`, because a directory of `.js`
 * files is not helpful.
 */
export function safeFileName(name: string, fallback = "workflow"): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug === "" ? fallback : slug;
}

export interface SaveResult {
  path: string;
  /** True when the name was taken and a number was added. */
  renamed: boolean;
}

/**
 * Write `script` into the project, without overwriting anything.
 *
 * Returns the path it used. Throws only when the directory cannot be made or the
 * file cannot be written, and the caller turns that into a message; a save that
 * fails must never take a run down with it.
 */
export function saveWorkflowScript(input: {
  cwd: string;
  name: string;
  script: string;
  /** Reads with `existsSync`; a seam, so a test needs no disk. */
  exists?: (path: string) => boolean;
  write?: (path: string, text: string) => void;
  mkdir?: (path: string) => void;
}): SaveResult {
  const exists = input.exists ?? existsSync;
  const write = input.write ?? ((path: string, text: string) => writeFileSync(path, text, "utf8"));
  const mkdir = input.mkdir ?? ((path: string) => mkdirSync(path, { recursive: true }));

  const dir = saveDir(input.cwd);
  mkdir(dir);
  const base = safeFileName(input.name);
  let path = join(dir, `${base}.js`);
  let renamed = false;
  for (let index = 2; exists(path) && index < 100; index += 1) {
    path = join(dir, `${base}-${index}.js`);
    renamed = true;
  }
  write(path, input.script.endsWith("\n") ? input.script : `${input.script}\n`);
  return { path, renamed };
}
