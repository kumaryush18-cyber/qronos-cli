// fs half of layered memory: turns the pure rules in memory.ts into a prompt
// block for the real filesystem.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MEMORY_FILE_NAME,
  memoryCandidates,
  renderMemoryPrompt,
  resolveMemory,
  type ResolvedMemory,
} from "./memory";

function safeRead(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Directory-scoped memory for the given files, keeping only ancestors that
 * actually sit inside `root` (so a file outside the project cannot pull in an
 * unrelated directory's memory).
 */
export function subdirsForFiles(root: string, files: readonly string[]): string[] {
  const out = new Set<string>();
  for (const f of files) {
    if (f.startsWith("/") && !f.startsWith(root)) continue;
    const rel = f.startsWith(root) ? f.slice(root.length).replace(/^\/+/, "") : f;
    const parts = rel.split("/").filter(Boolean);
    for (let i = 1; i < parts.length; i++) out.add(parts.slice(0, i).join("/"));
  }
  return [...out].sort();
}

/** Load memory for a project root. `files` enables directory-scoped layers. */
export function loadMemory(root: string, userMemoryPath: string, files: readonly string[] = []): ResolvedMemory {
  const candidates = memoryCandidates(root, userMemoryPath, subdirsForFiles(root, files));
  return resolveMemory(candidates, { readFile: safeRead });
}

/** Convenience: the prompt block, ready to append, or "" when there is none. */
export function loadMemoryPrompt(root: string, userMemoryPath: string): string {
  return renderMemoryPrompt(loadMemory(root, userMemoryPath));
}

/** Paths checked, for a /memory readout. */
export function memoryPathsFor(root: string, userMemoryPath: string): string[] {
  return memoryCandidates(root, userMemoryPath).map((c) => join(c.path));
}

export { MEMORY_FILE_NAME };
