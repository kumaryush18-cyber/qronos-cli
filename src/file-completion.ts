// `@file` completion for the prompt editor.
//
// Finding that shaped this module: pi's CombinedAutocompleteProvider already
// handles `@path`, but every one of its file lookups starts with
// if (!this.fdPath) return [];
// and fdPath comes from ensureTool("fd"), which returns undefined in offline
// mode, on Android, or when the managed download fails. In those cases typing
// `@src` shows nothing at all: no suggestions, no error, no hint. That silence
// is the actual gap, not the absence of an @ provider.
//
// So this wraps pi's provider rather than replacing it:
// - on the fd path, pi's fast .gitignore-aware walk still wins;
// - when pi returns nothing for an @ token, a bounded fs walk fills in;
// - `@file.ts#12-40` line ranges are added, and they complete as plain paths.
//
// The fs walk is deliberately conservative: it skips heavy directories, caps
// entries visited, and never follows symlinks, so a huge or cyclic tree cannot
// stall the editor.
import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions } from "@earendil-works/pi-tui";

/** Directories never worth walking for a completion. */
export const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  ".next",
  ".nuxt",
  ".cache",
  ".turbo",
  ".venv",
  "venv",
  "__pycache__",
  ".idea",
  ".vscode",
  "coverage",
  "vendor",
]);

export const MAX_ENTRIES_VISITED = 4000;
export const MAX_SUGGESTIONS = 50;

export interface WalkOptions {
  maxEntries?: number;
  maxDepth?: number;
}

/**
 * Breadth-first file/dir listing under `root`, as repo-relative POSIX paths.
 * Bounded by entries visited and depth so it always terminates.
 */
export function walkProjectFiles(root: string, opts: WalkOptions = {}): string[] {
  const maxEntries = opts.maxEntries ?? MAX_ENTRIES_VISITED;
  const maxDepth = opts.maxDepth ?? 6;
  const out: string[] = [];
  let visited = 0;

  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (queue.length > 0 && visited < maxEntries) {
    const { dir, depth } = queue.shift()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (visited >= maxEntries) break;
      if (name === "." || name === "..") continue;
      const full = join(dir, name);
      let isDir = false;
      try {
        // lstat-free: statSync follows links, so re-check the entry we just read.
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDir && SKIP_DIRS.has(name)) continue;
      visited++;
      const rel = relative(root, full).split(sep).join("/");
      out.push(isDir ? `${rel}/` : rel);
      if (isDir && depth + 1 < maxDepth) queue.push({ dir: full, depth: depth + 1 });
    }
  }
  return out;
}

/** True when `candidate` matches `query` in order (fzf-style subsequence). */
export function subsequenceMatch(candidate: string, query: string): boolean {
  if (!query) return true;
  const c = candidate.toLowerCase();
  const q = query.toLowerCase();
  let i = 0;
  for (const ch of c) {
    if (ch === q[i]) i++;
    if (i === q.length) return true;
  }
  return i === q.length;
}

/** Rank: prefix > basename prefix > segment prefix > subsequence. Higher wins. */
export function scoreCandidate(candidate: string, query: string): number {
  if (!query) return 1;
  const c = candidate.toLowerCase();
  const q = query.toLowerCase();
  if (c.startsWith(q)) return 100;
  const base = c.split("/").pop() ?? c;
  if (base.startsWith(q)) return 80;
  if (c.includes(`/${q}`)) return 60;
  if (c.includes(q)) return 40;
  if (subsequenceMatch(candidate, query)) return 20;
  return 0;
}

export interface FileCompletionDeps {
  /** Lists repo-relative paths. Injected so tests need no real tree. */
  listFiles(root: string): string[];
}

const realDeps: FileCompletionDeps = { listFiles: (root) => walkProjectFiles(root) };

/**
 * Suggestions for an `@` token, built from a plain file list. Exported so the
 * fallback can be tested without pi's provider or a real filesystem.
 */
export function suggestFiles(
  query: string,
  files: readonly string[],
  deps: FileCompletionDeps = realDeps,
  root = "",
  limit = MAX_SUGGESTIONS,
): AutocompleteItem[] {
  const all = files.length > 0 ? files : deps.listFiles(root);
  // A line range is the user telling us which file they mean, not part of the
  // name, so it must not take part in matching.
  const queryPath = trimLineRange(query);
  const scored: Array<{ item: AutocompleteItem; score: number; depth: number }> = [];
  for (const raw of all) {
    const path = trimLineRange(raw);
    const score = scoreCandidate(path, queryPath);
    if (score <= 0) continue;
    const isDir = path.endsWith("/");
    // Preserve a range the user already typed onto the completion value.
    const suffix = query.includes("#") && !isDir ? query.slice(query.indexOf("#")) : "";
    scored.push({
      score,
      depth: path.split("/").filter(Boolean).length,
      item: {
        value: `@${path}${suffix}`,
        label: path,
        description: isDir ? "directory" : undefined,
      },
    });
  }
  scored.sort((a, b) => (b.score - a.score) || (a.depth - b.depth) || a.item.label.localeCompare(b.item.label));
  return scored.slice(0, limit).map((s) => s.item);
}

/** `path.ts#12-40` -> `path.ts`. */
export function trimLineRange(value: string): string {
  const hash = value.indexOf("#");
  return hash === -1 ? value : value.slice(0, hash);
}

/** Parse an `@`-prefixed token into its path query, or undefined if not one. */
export function parseAtToken(textBeforeCursor: string): string | undefined {
  // Quoted form: @"src/my file" — allow spaces up to the closing quote
  // (or to end of input while the quote is still open).
  const quoted = /(?:^|[\s(])@"([^"\n]*)$/u.exec(textBeforeCursor);
  if (quoted) return quoted[1] ?? "";
  const plain = /(^|[\s(])@([^\s"]*)$/u.exec(textBeforeCursor);
  if (!plain) return undefined;
  return plain[2] ?? "";
}

/**
 * Wrap pi's provider: keep its behaviour, and only step in when it has nothing
 * to offer for an @ token (the fd-unavailable case).
 */
export function createFileCompletionProvider(
  deps: FileCompletionDeps = realDeps,
  getRoot: () => string,
): (cur: AutocompleteProvider) => AutocompleteProvider {
  return (cur) => ({
    get triggerCharacters() {
      return cur.triggerCharacters;
    },
    shouldTriggerFileCompletion: (...a) => cur.shouldTriggerFileCompletion?.(...a) ?? true,
    applyCompletion: (...a) => cur.applyCompletion(...a),
    async getSuggestions(lines, cursorLine, cursorCol, options): Promise<AutocompleteSuggestions | null> {
      const primary = await cur.getSuggestions(lines, cursorLine, cursorCol, options);
      if (primary && primary.items.length > 0) return primary;

      const line = lines[cursorLine] ?? "";
      const before = line.slice(0, cursorCol);
      const query = parseAtToken(before);
      if (query === undefined) return primary;
      if (options.signal.aborted) return primary;

      const root = getRoot();
      const items = suggestFiles(query, [], deps, root);
      if (items.length === 0) return primary;
      return { items, prefix: `@${query}` };
    },
  });
}
