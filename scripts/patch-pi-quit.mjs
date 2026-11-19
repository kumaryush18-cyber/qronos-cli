#!/usr/bin/env node
// Make the /quit command read "Quit", not "Quit pi".
//
// Why this script exists: pi builds its command list with the template
// `Quit ${APP_NAME}` and APP_NAME is hard-coded to "pi" in its bundle. pi does
// not let an extension replace a built-in command (built-in names win), so the
// only place to change the label is the installed pi files themselves.
//
// The change is one string, it is idempotent, and it is skipped silently when
// the pattern is absent (a future pi version may have rewritten it).
import { existsSync, globSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FROM = /description:\s*`Quit \$\{APP_NAME\}`/g;
const TO = 'description: "Quit"';

/** Pure text transform, so it can be tested without touching node_modules. */
export function patchQuitLabel(source) {
  return source.replace(FROM, TO);
}

/** Files that hold the command list: the ESM source and the bundled CLI. */
function targetFiles(piRoot) {
  const files = [join(piRoot, "dist/core/slash-commands.js")];
  const bundleDir = join(piRoot, "dist/bundle/chunks");
  if (existsSync(bundleDir)) {
    for (const name of globSync("*.js", { cwd: bundleDir })) {
      files.push(join(bundleDir, name));
    }
  }
  return files.filter((file) => existsSync(file));
}

/** Finds the installed pi package by walking up from this script. */
export function findPiRoot(startDir) {
  let dir = startDir;
  for (;;) {
    const candidate = join(dir, "node_modules", "@earendil-works", "pi-coding-agent");
    if (existsSync(join(candidate, "package.json"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const piRoot = findPiRoot(here) ?? findPiRoot(process.cwd());
  if (!piRoot) return; // pi not installed next to us: nothing to patch.

  let patched = 0;
  for (const file of targetFiles(piRoot)) {
    let source;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const next = patchQuitLabel(source);
    if (next === source) continue;
    try {
      writeFileSync(file, next);
      patched++;
    } catch {
      // Read-only install (e.g. a shared global store): keep going quietly.
    }
  }
  if (patched > 0) console.log(`qronos-cli: /quit label cleaned in ${patched} file(s)`);
}

main();
