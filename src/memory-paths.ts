// Where a project's memory lives on disk.
//
// Layout, one folder per project inside the agent dir (never inside the repo,
// so memory is not committed and cannot be read by a teammate by accident):
//
//   ~/.qronos/agent/memories/<slug>-<hash>/
//     MEMORY.md          curated long-term doc (decisions, constraints, ...)
//     memory_summary.md  the compact block injected into the system prompt
//     learned.md         explicit lessons the agent saved with `learn`
//     journal.jsonl      turns not yet consolidated (the pipeline's input)
//     state.json         counters + last sync, so work is never redone
//     lock               one consolidator at a time
//
// The slug is the repository root's basename, lowercased, plus a short hash of
// the absolute root path. Two projects both called "General" therefore keep
// separate memory instead of silently sharing one.
import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export const MEMORIES_DIR = "memories";
export const MEMORY_DOC_FILE = "MEMORY.md";
export const MEMORY_SUMMARY_FILE = "memory_summary.md";
export const MEMORY_LESSONS_FILE = "learned.md";
export const MEMORY_JOURNAL_FILE = "journal.jsonl";
export const MEMORY_STATE_FILE = "state.json";
export const MEMORY_LOCK_FILE = "lock";

/** Longest slug we keep before the hash, so paths stay readable. */
const MAX_SLUG = 40;

export interface MemoryPaths {
  /** The project's memory directory. */
  root: string;
  doc: string;
  summary: string;
  lessons: string;
  journal: string;
  state: string;
  lock: string;
}

/** Filesystem reads we allow a test to replace. */
export interface PathDeps {
  exists(path: string): boolean;
  isDirectory(path: string): boolean;
}

const realDeps: PathDeps = {
  exists: (path) => existsSync(path),
  isDirectory: (path) => {
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  },
};

/**
 * Lowercase, safe folder name from a project name. Anything that is not a
 * letter, digit, dash or underscore becomes a dash, and runs collapse.
 */
export function slugify(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
  if (cleaned === "") return "project";
  return cleaned.length > MAX_SLUG ? cleaned.slice(0, MAX_SLUG).replace(/[-_]+$/, "") : cleaned;
}

/**
 * Short, stable hash of an absolute path. 8 hex chars = 32 bits: enough to
 * separate two same-named projects, short enough to read in `/memory view`.
 */
export function pathHash(absolutePath: string): string {
  return createHash("sha256").update(absolutePath).digest("hex").slice(0, 8);
}

/**
 * The repository root above `cwd`, or `cwd` itself when there is none. Uses
 * `.git` existence (a file is enough: worktrees and submodules use a file).
 * Climbing stops at the filesystem root.
 */
export function findRepoRoot(cwd: string, deps: PathDeps = realDeps): string {
  let current = resolve(cwd);
  for (let depth = 0; depth < 64; depth += 1) {
    if (deps.exists(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return resolve(cwd);
}

/** Folder name for a project: `<slug>-<hash of the absolute root>`. */
export function projectFolder(cwd: string, repoRoot: string = findRepoRoot(cwd)): string {
  const root = resolve(repoRoot);
  return `${slugify(basename(root))}-${pathHash(root)}`;
}

/** Every path the memory pipeline touches for one project. */
export function memoryFiles(agentDir: string, cwd: string, repoRoot?: string): MemoryPaths {
  const root = join(resolve(agentDir), MEMORIES_DIR, projectFolder(cwd, repoRoot));
  return {
    root,
    doc: join(root, MEMORY_DOC_FILE),
    summary: join(root, MEMORY_SUMMARY_FILE),
    lessons: join(root, MEMORY_LESSONS_FILE),
    journal: join(root, MEMORY_JOURNAL_FILE),
    state: join(root, MEMORY_STATE_FILE),
    lock: join(root, MEMORY_LOCK_FILE),
  };
}
