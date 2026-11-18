// /init — generate a project memory file (QRONOS.md) by actually scanning the
// working directory, the way Claude Code's /init does.
//
// It is a *static* scan on purpose: no network, no model call, no writes
// outside the one file. The point is to hand the agent a real map of the
// project — stack, commands, folder layout, entry points, conventions, test
// setup — instead of a generic template.
//
// Everything here is split into pure scanning (scanProject/renderQronosMd,
// easy to unit-test on a fixture folder) and the two thin entry points
// (runInit for the TUI, runInitCli for `qronos init`).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import { createInterface } from "node:readline";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export const MEMORY_FILE = "QRONOS.md";

/** Directories that never describe the project's own code. */
const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  "vendor",
  "coverage",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  ".venv",
  "venv",
  "env",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".idea",
  ".vscode",
  ".qronos",
  ".pi",
  "tmp",
  "logs",
  "images",
  "screenshots",
]);

const MAX_FILES = 6000;
const MAX_TREE_LINES = 45;
const TREE_DEPTH = 2;
const MAX_DIRS_PER_LEVEL = 14;

const LANGUAGE_BY_EXT: Record<string, string> = {
  ".ts": "TypeScript",
  ".tsx": "TypeScript (React)",
  ".mts": "TypeScript",
  ".cts": "TypeScript",
  ".js": "JavaScript",
  ".jsx": "JavaScript (React)",
  ".mjs": "JavaScript",
  ".cjs": "JavaScript",
  ".py": "Python",
  ".rs": "Rust",
  ".go": "Go",
  ".java": "Java",
  ".kt": "Kotlin",
  ".swift": "Swift",
  ".rb": "Ruby",
  ".php": "PHP",
  ".cs": "C#",
  ".c": "C",
  ".h": "C",
  ".cpp": "C++",
  ".hpp": "C++",
  ".sh": "Shell",
  ".sql": "SQL",
  ".html": "HTML",
  ".css": "CSS",
  ".scss": "CSS",
  ".vue": "Vue",
  ".svelte": "Svelte",
  ".dart": "Dart",
  ".ex": "Elixir",
  ".exs": "Elixir",
  ".zig": "Zig",
  ".lua": "Lua",
};

export interface ProjectCommands {
  install?: string;
  dev?: string;
  build?: string;
  test?: string;
  lint?: string;
  typecheck?: string;
  format?: string;
}

export interface DirNode {
  name: string;
  dirs: DirNode[];
  files: string[];
}

export interface ScanResult {
  projectName: string;
  description: string;
  stack: string[];
  languages: { name: string; files: number }[];
  fileCount: number;
  packageManager?: string;
  commands: ProjectCommands;
  tree?: DirNode;
  entryPoints: string[];
  keyFiles: string[];
  sourceDirs: { path: string; files: number }[];
  testFramework?: string;
  testFiles: number;
  conventions: string[];
  workspaces: string[];
  existingDocs: string[];
  otherMemoryFiles: string[];
}

// ---------------------------------------------------------------------------
// small fs helpers
// ---------------------------------------------------------------------------

function safeRead(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function safeJson(path: string): Record<string, any> | undefined {
  const raw = safeRead(path);
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, any>) : undefined;
  } catch {
    return undefined;
  }
}

function toPosix(p: string): string {
  return p.split(sep).join("/");
}

/** Extra ignore names taken from .gitignore (top-level, plain names only). */
function readGitignoreDirs(root: string): Set<string> {
  const out = new Set<string>();
  const raw = safeRead(join(root, ".gitignore"));
  if (!raw) return out;
  for (const line of raw.split(/\r?\n/)) {
    const entry = line.trim();
    if (!entry || entry.startsWith("#") || entry.startsWith("!") || entry.includes("*")) continue;
    const clean = entry.replace(/^\/+/, "").replace(/\/+$/, "");
    if (clean && !clean.includes("/")) out.add(clean);
  }
  return out;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// walking
// ---------------------------------------------------------------------------

/** Collect relative file paths, bounded by MAX_FILES so a huge repo stays fast. */
export function collectFiles(root: string): string[] {
  const ignored = new Set([...IGNORED_DIRS, ...readGitignoreDirs(root)]);
  const files: string[] = [];
  const walk = (dir: string): void => {
    if (files.length >= MAX_FILES) return;
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of entries) {
      if (files.length >= MAX_FILES) return;
      if (name.startsWith(".") && name !== ".env.example") continue;
      const full = join(dir, name);
      if (isDir(full)) {
        if (ignored.has(name)) continue;
        walk(full);
      } else if (isFile(full)) {
        files.push(toPosix(relative(root, full)));
      }
    }
  };
  walk(root);
  return files;
}

/** Shallow tree for the folder map (depth-limited, so the file stays readable). */
export function buildTree(root: string, maxDepth = TREE_DEPTH): DirNode | undefined {
  const ignored = new Set([...IGNORED_DIRS, ...readGitignoreDirs(root)]);
  let dirCount = 0;
  const build = (dir: string, name: string, depth: number): DirNode => {
    const node: DirNode = { name, dirs: [], files: [] };
    dirCount++;
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return node;
    }
    for (const entry of entries) {
      if (entry.startsWith(".")) continue;
      const full = join(dir, entry);
      if (isDir(full)) {
        if (ignored.has(entry) || dirCount > 400) continue;
        if (depth < maxDepth) node.dirs.push(build(full, entry, depth + 1));
        else node.dirs.push({ name: entry, dirs: [], files: [] });
      } else if (isFile(full) && node.files.length < MAX_DIRS_PER_LEVEL * 2) {
        node.files.push(entry);
      }
    }
    return node;
  };
  return build(root, basename(root) || "project", 0);
}

export function renderTree(node: DirNode, maxLines = MAX_TREE_LINES): string[] {
  const lines: string[] = [];
  const push = (line: string) => {
    if (lines.length < maxLines) lines.push(line);
  };
  push(`${node.name}/`);
  const walk = (current: DirNode, prefix: string, depth: number): void => {
    if (depth >= TREE_DEPTH) return;
    const slots = [...current.dirs.map((d) => ({ dir: d, label: `${d.name}/` })), ...current.files.map((f) => ({ dir: undefined, label: f }))];
    slots.forEach((slot, i) => {
      const last = i === slots.length - 1;
      push(`${prefix}${last ? "└── " : "├── "}${slot.label}`);
      if (slot.dir) walk(slot.dir, `${prefix}${last ? "    " : "│   "}`, depth + 1);
    });
  };
  walk(node, "", 0);
  if (lines.length >= maxLines) lines.push("… (tree trimmed)");
  return lines;
}

// ---------------------------------------------------------------------------
// detection
// ---------------------------------------------------------------------------

export function detectPackageManager(root: string): PackageManager | undefined {
  if (existsSync(join(root, "bun.lock")) || existsSync(join(root, "bun.lockb"))) {
    return { name: "bun", run: (s) => `bun run ${s}` };
  }
  if (existsSync(join(root, "pnpm-lock.yaml"))) return { name: "pnpm", run: (s) => `pnpm run ${s}` };
  if (existsSync(join(root, "yarn.lock"))) return { name: "yarn", run: (s) => `yarn ${s}` };
  if (existsSync(join(root, "package-lock.json"))) return { name: "npm", run: (s) => (s === "test" ? "npm test" : `npm run ${s}`) };
  if (existsSync(join(root, "package.json"))) return { name: "npm", run: (s) => (s === "test" ? "npm test" : `npm run ${s}`) };
  return undefined;
}

const SCRIPT_KEYS: (keyof ProjectCommands)[] = ["dev", "build", "test", "lint", "typecheck", "format"];

function joinLines(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const first = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && !l.startsWith("![") && !l.startsWith("<"))[0];
  if (!first) return undefined;
  return first.replace(/[*_`]/g, "").slice(0, 220);
}

function listDeps(root: string): string[] {
  const pkg = safeJson(join(root, "package.json"));
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) } as Record<string, string>;
  return Object.keys(deps);
}

type PackageManager = { name: string; run: (script: string) => string };

function detectTestFramework(root: string, deps: string[], pm?: PackageManager): string | undefined {
  const has = (n: string) => deps.some((d) => d === n || d.startsWith(`${n}@`));
  if (has("vitest")) return "Vitest";
  if (has("jest")) return "Jest";
  if (has("mocha")) return "Mocha";
  if (has("ava")) return "AVA";
  if (existsSync(join(root, "pytest.ini")) || existsSync(join(root, "conftest.py"))) return "pytest";
  if (existsSync(join(root, "Cargo.toml"))) return "cargo test";
  if (existsSync(join(root, "go.mod"))) return "go test";
  if (pm?.name === "bun" && existsSync(join(root, "bun.lock"))) return "bun test";
  return undefined;
}

function detectEntryPoints(root: string, files: string[]): string[] {
  const wanted = new Set([
    "src/index.ts",
    "src/index.tsx",
    "src/index.js",
    "src/index.mjs",
    "src/main.ts",
    "src/main.js",
    "src/cli.ts",
    "src/app.ts",
    "src/server.ts",
    "src/server.js",
    "src/app.tsx",
    "src/app.jsx",
    "index.ts",
    "index.js",
    "main.ts",
    "main.js",
    "main.py",
    "app.py",
    "manage.py",
    "cmd/server/main.go",
    "main.go",
    "src/main.rs",
    "src/lib.rs",
    "src/App.tsx",
    "src/App.jsx",
  ]);
  const picked = files.filter((f) => wanted.has(f));
  // Rust/Go/Python projects rarely match the JS-ish names above.
  if (picked.length === 0) {
    const fallback = files.find((f) => /^(src\/)?(main|index|lib|app)\.[a-z]+$/.test(f));
    if (fallback) picked.push(fallback);
  }
  return picked.slice(0, 8);
}

function countByExt(files: string[]): { name: string; files: number }[] {
  const counts = new Map<string, number>();
  for (const f of files) {
    const ext = f.slice(f.lastIndexOf("."));
    const lang = LANGUAGE_BY_EXT[ext];
    if (!lang) continue;
    counts.set(lang, (counts.get(lang) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, n]) => ({ name, files: n }))
    .sort((a, b) => b.files - a.files)
    .slice(0, 6);
}

function sourceDirs(files: string[]): { path: string; files: number }[] {
  const counts = new Map<string, number>();
  for (const f of files) {
    const parts = f.split("/");
    if (parts.length < 3) continue;
    const top = parts[0];
    if (!/(src|lib|app|packages|apps|services|internal|pkg|cmd|crates)/.test(top ?? "")) continue;
    const key = parts.length > 3 ? `${parts[0]}/${parts[1]}` : (parts[0] ?? "");
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([path, n]) => ({ path, files: n }))
    .sort((a, b) => b.files - a.files)
    .slice(0, 10);
}

function readWorkspaces(root: string): string[] {
  const pkg = safeJson(join(root, "package.json"));
  const ws = pkg?.workspaces;
  if (Array.isArray(ws)) return ws.filter((w): w is string => typeof w === "string");
  if (ws && typeof ws === "object" && Array.isArray(ws.packages)) {
    return ws.packages.filter((w: unknown): w is string => typeof w === "string");
  }
  const out: string[] = [];
  for (const dir of ["packages", "apps", "services", "crates"]) {
    if (isDir(join(root, dir))) {
      try {
        const children = readdirSync(join(root, dir)).filter((c) => isDir(join(root, dir, c)));
        if (children.length > 0) out.push(`${dir}/*`);
      } catch {
        // ignore
      }
    }
  }
  return out;
}

function detectConventions(root: string, deps: string[]): string[] {
  const out: string[] = [];
  const tsconfig = safeRead(join(root, "tsconfig.json"));
  if (tsconfig && /"strict"\s*:\s*true/.test(tsconfig)) out.push("TypeScript runs in **strict** mode; keep types explicit and avoid `any`.");
  const pkg = safeJson(join(root, "package.json"));
  if (pkg?.type === "module") out.push("ES modules (`type: module`): use `import`/`export`, not `require`.");
  if (tsconfig) {
    const alias = /"paths"\s*:\s*\{/.test(tsconfig);
    if (alias) out.push("`tsconfig.json` defines path aliases — import through those instead of long relative paths.");
  }
  const editorconfig = safeRead(join(root, ".editorconfig"));
  if (editorconfig) {
    const size = /indent_size\s*=\s*(\d+)/.exec(editorconfig)?.[1];
    const style = /indent_style\s*=\s*(\w+)/.exec(editorconfig)?.[1];
    if (style === "tab") out.push("Indentation: **tabs** (see `.editorconfig`).");
    else if (size) out.push(`Indentation: **${size} spaces** (see \`.editorconfig\`).`);
  }
  if (existsSync(join(root, ".prettierrc")) || existsSync(join(root, ".prettierrc.json")) || deps.includes("prettier")) {
    out.push("Formatting is Prettier-managed — do not hand-align code.");
  }
  if (deps.includes("eslint") || existsSync(join(root, "eslint.config.js")) || existsSync(join(root, ".eslintrc"))) {
    out.push("Lint with ESLint before calling work done.");
  }
  if (deps.includes("@biomejs/biome")) out.push("Biome handles both lint and format.");
  if (existsSync(join(root, "pyproject.toml"))) out.push("Python config lives in `pyproject.toml`; run tools through it.");
  const agents = existsSync(join(root, "AGENTS.md")) || existsSync(join(root, "CLAUDE.md"));
  if (agents) out.push("This repo already has an `AGENTS.md`/`CLAUDE.md` — follow it; `QRONOS.md` is additive.");
  return out;
}

function detectCommands(root: string, deps: string[], pm: ReturnType<typeof detectPackageManager>, files: string[]): ProjectCommands {
  const commands: ProjectCommands = {};
  const pkg = safeJson(join(root, "package.json"));
  const scripts = (pkg?.scripts ?? {}) as Record<string, string>;
  if (pm) commands.install = pm.name === "npm" ? "npm install" : `${pm.name} install`;
  for (const key of SCRIPT_KEYS) {
    const scriptName = Object.keys(scripts).find((s) => s === key || s === `${key}:all`);
    if (scriptName && pm) commands[key] = pm.run(scriptName);
  }
  if (existsSync(join(root, "Cargo.toml"))) {
    commands.build ??= "cargo build";
    commands.test ??= "cargo test";
    commands.lint ??= "cargo clippy -- -D warnings";
    commands.format ??= "cargo fmt";
  }
  if (existsSync(join(root, "pyproject.toml")) || existsSync(join(root, "requirements.txt"))) {
    commands.test ??= "pytest";
    commands.lint ??= "ruff check .";
    commands.format ??= "ruff format .";
  }
  if (existsSync(join(root, "go.mod"))) {
    commands.build ??= "go build ./...";
    commands.test ??= "go test ./...";
    commands.lint ??= "go vet ./...";
  }
  if (existsSync(join(root, "Makefile")) && !commands.build) commands.build = "make";
  if (!commands.test && files.some((f) => f.startsWith("test/") || f.includes(".test."))) {
    commands.test = detectTestFramework(root, deps, pm) ?? commands.test;
  }
  return commands;
}

export function scanProject(cwd: string): ScanResult {
  const files = collectFiles(cwd);
  const pkg = safeJson(join(cwd, "package.json"));
  const pm = detectPackageManager(cwd);
  const deps = listDeps(cwd);
  const readme = safeRead(join(cwd, "README.md")) ?? safeRead(join(cwd, "readme.md"));
  const languages = countByExt(files);
  const testFiles = files.filter((f) => /(\.test\.|\.spec\.|^test\/|^tests\/|_test\.)/.test(f)).length;

  const stack: string[] = [];
  for (const lang of languages) stack.push(lang.name);
  if (Array.isArray(pkg?.workspaces) || (pkg?.workspaces && typeof pkg.workspaces === "object")) stack.push("monorepo");
  if (deps.includes("react") || deps.includes("next")) stack.push("React");
  if (deps.includes("next")) stack.push("Next.js");
  if (deps.includes("vue")) stack.push("Vue");
  if (deps.includes("express")) stack.push("Express");
  if (deps.includes("fastify")) stack.push("Fastify");
  if (deps.includes("@earendil-works/pi-coding-agent")) stack.push("pi agent SDK");
  const stackUnique = [...new Set(stack)].slice(0, 8);

  const keyCandidates = [
    "package.json",
    "tsconfig.json",
    "bunfig.toml",
    "vite.config.ts",
    "next.config.js",
    "next.config.mjs",
    "jest.config.js",
    "vitest.config.ts",
    "eslint.config.js",
    ".eslintrc",
    ".prettierrc",
    "biome.json",
    ".editorconfig",
    "Cargo.toml",
    "pyproject.toml",
    "requirements.txt",
    "go.mod",
    "Makefile",
    "Dockerfile",
    "docker-compose.yml",
    ".github/workflows",
  ];
  const keyFiles = keyCandidates.filter((f) => existsSync(join(cwd, f)));
  const existingDocs = ["README.md", "AGENTS.md", "CLAUDE.md", "CONTRIBUTING.md", "CODE_OF_CONDUCT.md"].filter((f) =>
    existsSync(join(cwd, f)),
  );
  const otherMemoryFiles = files.filter((f) => f === ".cursorrules" || f.endsWith("/CLAUDE.md") || f.endsWith("/AGENTS.md"));

  return {
    projectName: (pkg?.name as string | undefined) || basename(cwd) || "Project",
    description: (pkg?.description as string | undefined) || joinLines(readme) || "",
    stack: stackUnique,
    languages,
    fileCount: files.length,
    packageManager: pm?.name,
    commands: detectCommands(cwd, deps, pm, files),
    tree: buildTree(cwd),
    entryPoints: detectEntryPoints(cwd, files),
    keyFiles,
    sourceDirs: sourceDirs(files),
    testFramework: detectTestFramework(cwd, deps, pm),
    testFiles,
    conventions: detectConventions(cwd, deps),
    workspaces: readWorkspaces(cwd),
    existingDocs,
    otherMemoryFiles,
  };
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

function commandTable(commands: ProjectCommands): string[] {
  const rows: [string, string | undefined][] = [
    ["Install", commands.install],
    ["Dev server", commands.dev],
    ["Build", commands.build],
    ["Test", commands.test],
    ["Lint", commands.lint],
    ["Type check", commands.typecheck],
    ["Format", commands.format],
  ];
  const present = rows.filter(([, value]) => Boolean(value));
  if (present.length === 0) return ["_No commands detected — add them here._"];
  const lines = ["| Task | Command |", "| --- | --- |"];
  for (const [label, value] of present) lines.push(`| ${label} | \`${value}\` |`);
  return lines;
}

export function renderQronosMd(scan: ScanResult, today = new Date()): string {
  const date = today.toISOString().slice(0, 10);
  const out: string[] = [];

  out.push("# QRONOS.md — Project Guide for the Qronos AI agent", "");
  out.push(
    `> Generated by \`qronos init\` on ${date} from a static scan of this working copy.`,
    "> It is a starting point, not law: edit it, delete what is wrong, add what the scan cannot see",
    "> (runtime behaviour, data flows, why decisions were made). It loads automatically every session.",
    "",
  );

  out.push("## 1. Overview", "");
  out.push(`- **Project:** ${scan.projectName}`);
  if (scan.description) out.push(`- **What it is:** ${scan.description}`);
  if (scan.stack.length > 0) out.push(`- **Stack:** ${scan.stack.join(", ")}`);
  if (scan.packageManager) out.push(`- **Package manager:** ${scan.packageManager}`);
  if (scan.workspaces.length > 0) out.push(`- **Workspaces:** ${scan.workspaces.join(", ")}`);
  out.push(`- **Source files scanned:** ${scan.fileCount}`);
  if (scan.languages.length > 0) {
    out.push(`- **Languages by file count:** ${scan.languages.map((l) => `${l.name} (${l.files})`).join(", ")}`);
  }
  out.push("");

  out.push("## 2. Commands", "");
  out.push(...commandTable(scan.commands));
  out.push("", "Always run the build and the test suite before saying a change is complete.", "");

  out.push("## 3. Project structure", "");
  if (scan.tree) {
    out.push("```");
    out.push(...renderTree(scan.tree));
    out.push("```", "");
  }
  if (scan.sourceDirs.length > 0) {
    out.push("**Main source areas** (by file count):", "");
    for (const dir of scan.sourceDirs) out.push(`- \`${dir.path}/\` — ${dir.files} files`);
    out.push("");
  }
  if (scan.entryPoints.length > 0) {
    out.push("**Entry points** — start reading here:", "");
    for (const entry of scan.entryPoints) out.push(`- \`${entry}\``);
    out.push("");
  }
  if (scan.keyFiles.length > 0) {
    out.push(`**Key config files:** ${scan.keyFiles.map((f) => `\`${f}\``).join(", ")}`, "");
  }
  if (scan.existingDocs.length > 0) {
    out.push(`**Existing docs:** ${scan.existingDocs.map((f) => `\`${f}\``).join(", ")}`, "");
  }

  out.push("## 4. Conventions", "");
  if (scan.conventions.length > 0) {
    for (const rule of scan.conventions) out.push(`- ${rule}`);
  } else {
    out.push("- Follow the style of the surrounding code; match imports, naming and error handling.");
  }
  out.push("- Keep changes small and reviewable. Prefer the `edit` tool over rewriting whole files.", "");

  out.push("## 5. Testing", "");
  if (scan.testFramework) out.push(`- **Test runner:** ${scan.testFramework}`);
  if (scan.commands.test) out.push(`- **Run everything:** \`${scan.commands.test}\``);
  out.push(`- **Test files found:** ${scan.testFiles}`);
  out.push("- Add or update a test when you change behaviour; a fix without a test is unfinished.");
  out.push("- Run the single failing test first, then the full suite.", "");

  out.push("## 6. Working agreement", "");
  out.push("- Read the relevant files before editing. Never guess an API — check it.");
  out.push("- Keep the plan in the todo tool for anything with 3 or more steps.");
  out.push("- Do not touch secrets, `.env` files, or generated folders such as `dist/` or `node_modules/`.");
  out.push("- Before finishing: run the build/test commands above and say plainly what you checked.");
  if (scan.otherMemoryFiles.length > 0) {
    out.push(`- Other instruction files to respect: ${scan.otherMemoryFiles.map((f) => `\`${f}\``).join(", ")}.`);
  }
  out.push("");
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// entry points
// ---------------------------------------------------------------------------

/**
 * `/init` inside the TUI: scan, then write QRONOS.md after asking before an
 * overwrite. Generates the file content once so the preview and the write agree.
 */
export async function runInit(ctx: ExtensionCommandContext): Promise<void> {
  const cwd = ctx.cwd || process.cwd();
  const qronosPath = join(cwd, MEMORY_FILE);

  if (existsSync(qronosPath)) {
    const overwrite = await ctx.ui.confirm(
      "QRONOS.md Already Exists",
      `A ${MEMORY_FILE} file already exists here. Overwrite it with a fresh scan of this project?`,
    );
    if (!overwrite) {
      ctx.ui.notify(`${MEMORY_FILE} setup cancelled.`, "info");
      return;
    }
  }

  let content: string;
  try {
    content = renderQronosMd(scanProject(cwd));
  } catch (err) {
    ctx.ui.notify(`Scan failed: ${err instanceof Error ? err.message : String(err)}`, "error");
    return;
  }

  try {
    await writeFile(qronosPath, content, "utf8");
  } catch (err) {
    ctx.ui.notify(`Failed to write ${MEMORY_FILE}: ${err instanceof Error ? err.message : String(err)}`, "error");
    return;
  }

  const sections = content.split("\n").filter((l) => l.startsWith("## ")).length;
  ctx.ui.notify(`✓ ${MEMORY_FILE} created (${sections} sections scanned from this project).`, "info");
}

/** Ask a yes/no question on the terminal. Returns false when stdin is not interactive. */
async function askTty(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((resolve) => rl.question(question, resolve));
    return /^\s*y(es)?\s*$/i.test(answer);
  } finally {
    rl.close();
  }
}

/** CLI entry point for `qronos init`. */
export async function runInitCli(): Promise<number> {
  const cwd = process.cwd();
  const target = join(cwd, MEMORY_FILE);

  if (existsSync(target) && process.stdin.isTTY) {
    const ok = await askTty(`\n${MEMORY_FILE} already exists. Overwrite with a fresh scan? [y/N] `);
    if (!ok) {
      console.log(`Cancelled. Kept the existing ${MEMORY_FILE}.`);
      return 0;
    }
  }

  let content: string;
  try {
    content = renderQronosMd(scanProject(cwd));
  } catch (err) {
    console.error(`Scan failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  try {
    await writeFile(target, content, "utf8");
  } catch (err) {
    console.error(`Failed to write ${MEMORY_FILE}: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  console.log(`✓ Created ${MEMORY_FILE} in ${cwd}`);
  console.log(`  ${content.split("\n").length} lines scanned from: package manifests, folder tree, entry points, conventions, tests.`);
  console.log("  Review it and edit anything the static scan got wrong.");
  return 0;
}
