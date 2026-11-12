// Layered project memory, Claude-Code style.
//
// Resolution order, lowest precedence first, matching CLAUDE.md's layout:
//   1. ~/.qronos/QRONOS.md          user-level, applies to every project
//   2. <root>/QRONOS.md             project root
//   3. <root>/<dir>/QRONOS.md       directory-scoped, for subdirectories of the
//                                   files in play (cwd and its ancestors only)
// Later sources win, so a project can override a user-level preference and a
// subdirectory can override the project.
//
// @import: a memory file may pull in another with a line that is just
// `@path/to/file.md`. Imports are resolved relative to the importing file,
// nested imports are allowed, and cycles are cut so a self-referential import
// cannot hang. Everything here is pure (contents are passed in as a map), so
// ordering, imports and cycle handling are testable without a filesystem.

export const MEMORY_FILE_NAME = "QRONOS.md";
export const MAX_IMPORT_DEPTH = 5;

export interface MemorySource {
  /** Absolute path, for display and import resolution. */
  path: string;
  /** Which layer produced it, for the /memory readout. */
  layer: "user" | "project" | "directory";
  contents: string;
}

/**
 * Candidate memory paths for a project, lowest precedence first.
 * `readdir`/`stat` are not used here: the caller decides which exist.
 */
export function memoryCandidates(root: string, userMemoryPath: string, subdirs: readonly string[] = []): Array<{ path: string; layer: MemorySource["layer"] }> {
  const out: Array<{ path: string; layer: MemorySource["layer"] }> = [
    { path: userMemoryPath, layer: "user" },
    { path: joinPath(root, MEMORY_FILE_NAME), layer: "project" },
  ];
  for (const dir of subdirs) {
    const clean = dir.replace(/^\.\/+/, "").replace(/\/+$/, "");
    if (clean === "" || clean === ".") continue;
    out.push({ path: joinPath(root, clean, MEMORY_FILE_NAME), layer: "directory" });
  }
  return out;
}

/** Minimal join so the module stays free of node:path for browser tests. */
function joinPath(...parts: string[]): string {
  return parts
    .filter((p) => p !== "")
    .join("/")
    .replace(/\/{2,}/g, "/");
}

/**
 * Ancestor directories of a file, nearest last, excluding the root itself.
 * `src/api/routes.ts` -> ["src", "src/api"].
 */
export function ancestorDirs(filePath: string): string[] {
  const parts = filePath.split("/").filter(Boolean);
  if (parts.length <= 1) return [];
  const dirs: string[] = [];
  for (let i = 1; i < parts.length; i++) {
    dirs.push(parts.slice(0, i).join("/"));
  }
  return dirs;
}

/** Lines that are exactly an @import. Directives inline in prose are ignored. */
export function parseImports(contents: string): string[] {
  const out: string[] = [];
  for (const line of contents.split("\n")) {
    const m = /^\s*@([^\s@][^\n]*?)\s*$/.exec(line);
    if (m) out.push(m[1]!);
  }
  return out;
}

/** Resolve `importPath` against `fromDir` without node:path. */
export function resolveImport(fromDir: string, importPath: string): string {
  if (importPath.startsWith("/")) return importPath;
  const base = fromDir.split("/").filter(Boolean);
  const parts = importPath.split("/");
  // The root's leading empty segment must survive, so track absolute-ness.
  const absolute = fromDir.startsWith("/");
  const stack: string[] = absolute ? [""] : [];
  stack.push(...base);
  for (const part of parts) {
    if (part === "." || part === "") continue;
    if (part === "..") {
      if (stack.length > (absolute ? 1 : 0)) stack.pop();
      continue;
    }
    stack.push(part);
  }
  const joined = stack.join("/");
  return absolute && !joined.startsWith("/") ? `/${joined}` : joined;
}

export interface ResolveMemoryDeps {
  /** Returns file contents, or undefined when the file does not exist. */
  readFile(path: string): string | undefined;
}

export interface ResolvedMemory {
  sources: MemorySource[];
  /** Import paths that could not be read, for a warning in /memory. */
  missing: string[];
  /** Imports skipped because they would revisit a file already inlined. */
  cycles: string[];
}

/**
 * Read every memory file that exists and inline its imports.
 * Missing files are skipped silently (the common case); a missing *import* is
 * recorded so the user can see their @import is broken.
 */
export function resolveMemory(
  candidates: ReadonlyArray<{ path: string; layer: MemorySource["layer"] }>,
  deps: ResolveMemoryDeps,
): ResolvedMemory {
  const sources: MemorySource[] = [];
  const missing: string[] = [];
  const cycles: string[] = [];
  const seen = new Set<string>();

  const expand = (path: string, layer: MemorySource["layer"], depth: number, isImport: boolean): string | undefined => {
    if (seen.has(path)) {
      if (isImport) cycles.push(path);
      return undefined;
    }
    const contents = deps.readFile(path);
    if (contents === undefined) {
      if (isImport) missing.push(path);
      return undefined;
    }
    seen.add(path);

    if (depth >= MAX_IMPORT_DEPTH) {
      sources.push({ path, layer, contents });
      return contents;
    }

    // Resolve imports before recording, so the importer's stored contents can
    // carry its imports inline rather than leaving a dangling @path line.
    const dir = path.slice(0, Math.max(0, path.lastIndexOf("/")));
    const inlined: string[] = [];
    const kept: string[] = [];
    for (const line of contents.split("\n")) {
      const m = /^\s*@([^\s@][^\n]*?)\s*$/.exec(line);
      if (!m) {
        kept.push(line);
        continue;
      }
      const resolved = resolveImport(dir, m[1]!);
      const included = expand(resolved, layer, depth + 1, true);
      if (included !== undefined) {
        inlined.push(included.trim());
        // Drop the import line itself: it is replaced by the imported text.
      } else {
        // Keep a broken import visible in the file text but out of the prompt,
        // so the user can still see what they wrote.
        kept.push(line);
      }
    }
    let merged = kept.join("\n").trimEnd();
    if (inlined.length > 0) merged = `${merged}\n\n${inlined.join("\n\n")}`;
    sources.push({ path, layer, contents: merged });
    return merged;
  };

  for (const c of candidates) expand(c.path, c.layer, 0, false);
  return { sources, missing, cycles };
}

/**
 * The block appended to the system prompt. Returns "" when there is no memory,
 * so a project without QRONOS.md pays no prompt tokens.
 */
export function renderMemoryPrompt(memory: ResolvedMemory): string {
  if (memory.sources.length === 0) return "";
  const sections = memory.sources.map(
    (s) => `### ${s.path} (${s.layer})\n\n${s.contents.trim()}`,
  );
  return [
    "## Project memory",
    "",
    "The following was provided by the user as standing instructions. Follow it.",
    "Later sections override earlier ones when they conflict.",
    "",
    sections.join("\n\n"),
  ].join("\n");
}
