// Which language server to run for which file.
//
// We do not install servers. If one is missing the tool says so and the model
// falls back to plain edits — an LSP that silently does nothing is worse than no
// LSP at all.
import { existsSync, realpathSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

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
  /** Absolute path of the executable. */
  command: string;
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
  if (!command) {
    return { reason: `${spec.name} is not installed. Install it with: ${spec.install}` };
  }
  return { server: { spec, command } };
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
