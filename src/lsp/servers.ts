// Which language server to run for which file.
//
// The TypeScript server and its compiler ship WITH qronos-cli (optional
// dependencies), so `lsp` works on a fresh install with nothing else to do.
// A project-local or global install still wins where one exists, because a
// project should be edited with the compiler version it was written against.
//
// Other languages are not bundled: Pyright/Rust/Go servers are large, native,
// and versioned with their toolchains. For those the tool says what to install
// instead of pretending to work.
import { existsSync, realpathSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface ServerSpec {
  /** Human name, used in messages. */
  name: string;
  /** Executable to look for on PATH. */
  command: string;
  args: string[];
  /** File extensions this server handles (with the dot). */
  extensions: string[];
  /** Install hint shown when the command is missing. */
  install: string;
}

export const LANGUAGE_SERVERS: ServerSpec[] = [
  {
    name: "typescript-language-server",
    command: "typescript-language-server",
    args: ["--stdio"],
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"],
    install: "npm install -g typescript-language-server typescript",
  },
  {
    name: "pyright",
    command: "pyright-langserver",
    args: ["--stdio"],
    extensions: [".py", ".pyi"],
    install: "npm install -g pyright",
  },
  {
    name: "rust-analyzer",
    command: "rust-analyzer",
    args: [],
    extensions: [".rs"],
    install: "rustup component add rust-analyzer",
  },
  {
    name: "gopls",
    command: "gopls",
    args: [],
    extensions: [".go"],
    install: "go install golang.org/x/tools/gopls@latest",
  },
];

/** Look for an executable on PATH without spawning anything. */
export function findOnPath(command: string, env: Record<string, string | undefined> = process.env): string | undefined {
  if (command.includes("/") || command.includes("\\")) return existsSync(command) ? command : undefined;
  const path = env.PATH ?? env.Path ?? "";
  const exts = process.platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, command + ext.toLowerCase());
      if (existsSync(candidate)) return candidate;
      if (ext && existsSync(join(dir, command + ext))) return join(dir, command + ext);
    }
  }
  return undefined;
}

export interface ResolvedServer {
  spec: ServerSpec;
  /** Absolute path of the executable (or the Node.js binary for a bundled entry). */
  command: string;
  /** Extra arguments; carries the bundled module path when command is Node.js. */
  args?: string[];
}

/**
 * Directory of the packages that ship with qronos-cli.
 *
 * The module may live at dist/index.js (published) or src/lsp/servers.ts (in the
 * repository), so the answer is found by walking up to the nearest node_modules
 * that actually contains the TypeScript server. A guessed "one level up" is
 * wrong in exactly one of those two layouts, which is why it is not guessed.
 */
export function bundledModulesDir(): string {
  const starts = [dirname(fileURLToPath(import.meta.url)), process.cwd()];
  for (const start of starts) {
    let dir = start;
    for (let depth = 0; depth < 6; depth++) {
      const candidate = join(dir, "node_modules");
      if (existsSync(join(candidate, "typescript-language-server"))) return candidate;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "node_modules");
}

/** The TypeScript server entry that ships with the CLI, when it was installed. */
export function bundledTypescriptServer(): string | undefined {
  const entry = join(bundledModulesDir(), "typescript-language-server", "lib", "cli.mjs");
  return existsSync(entry) ? entry : undefined;
}

export function resolveServerForPath(
  path: string,
  env: Record<string, string | undefined> = process.env,
  servers: readonly ServerSpec[] = LANGUAGE_SERVERS,
): { server?: ResolvedServer; reason?: string } {
  const lower = path.toLowerCase();
  const spec = servers.find((candidate) => candidate.extensions.some((ext) => lower.endsWith(ext)));
  if (!spec) return { reason: `no language server configured for ${path}` };

  const command = findOnPath(spec.command, env);
  if (command) return { server: { spec, command } };

  // Not on PATH: for TypeScript the bundled copy is enough, and it runs through
  // the current Node.js binary, so no launcher script or .bin shim is needed.
  if (spec.command === "typescript-language-server") {
    const entry = env.QRONOS_TSSERVER_ENTRY?.trim() || bundledTypescriptServer();
    if (entry && existsSync(entry)) {
      return { server: { spec, command: process.execPath, args: [entry, ...spec.args] } };
    }
  }

  return { reason: `${spec.name} is not installed. Install it with: ${spec.install}` };
}

/**
 * typescript-language-server needs a TypeScript install it can drive, and it
 * refuses to start without one ("Could not find a valid TypeScript
 * installation"). A project usually has its own copy, which is also the version
 * the project was written against, so that one wins:
 *   1. QRONOS_TSSERVER_PATH (explicit override)
 *   2. <cwd>/node_modules/typescript/lib/tsserver.js (the project's version)
 *   3. the copy that ships beside a global `tsc`
 */
export function findTsserverPath(
  cwd: string,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const explicit = env.QRONOS_TSSERVER_PATH?.trim();
  if (explicit && existsSync(explicit)) return explicit;

  const local = join(cwd, "node_modules", "typescript", "lib", "tsserver.js");
  if (existsSync(local)) return local;

  // The copy that ships with qronos-cli, so a project without a local install
  // still gets a working server.
  const bundled = join(bundledModulesDir(), "typescript", "lib", "tsserver.js");
  if (existsSync(bundled)) return bundled;

  const tsc = findOnPath("tsc", env);
  if (tsc) {
    try {
      const real = realpathSync(tsc);
      const candidate = join(dirname(real), "..", "lib", "tsserver.js");
      if (existsSync(candidate)) return candidate;
    } catch {
      // A broken symlink on PATH is not worth failing over.
    }
  }
  return undefined;
}

/**
 * Extra args for the server. typescript-language-server 6 removed
 * `--tsserver-path` (it now rejects unknown options), so the TypeScript
 * location is passed through initializationOptions instead; see
 * initializeOptionsFor().
 */
export function serverArgs(spec: ServerSpec): string[] {
  return [...spec.args];
}

/**
 * `initialize` options per server. For TypeScript this is where the tsserver
 * script goes, which is how version 6+ accepts it.
 */
export function initializeOptionsFor(
  cwd: string,
  spec: ServerSpec,
  env: Record<string, string | undefined> = process.env,
): Record<string, unknown> | undefined {
  if (spec.command !== "typescript-language-server") return undefined;
  const tsserver = findTsserverPath(cwd, env);
  return tsserver ? { tsserver: { path: tsserver } } : undefined;
}
