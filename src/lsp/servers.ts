// Which language server to run for which file.
//
// We do not install servers. If one is missing the tool says so and the model
// falls back to plain edits — an LSP that silently does nothing is worse than no
// LSP at all.
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

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
