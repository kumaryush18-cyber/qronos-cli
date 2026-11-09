// Pure argv parsing for the local commands (help / version / logout / mcp) and the
// `--session <id>` resume flag, extracted from index.ts (untestable: main() runs on import) as a test seam.
//
// Privacy note, same invariant as run()'s decline path: none of the commands
// parsed here ever contact the free-pi server — they print or touch local
// files and exit. (`mcp` reads and writes mcp.json and connects only to the
// MCP servers the user names.) --session is not one of them: it maps to { kind: "run" } (the id is validated
// in run.ts). Only { kind: "run" } proceeds into the consent-gated flow.
import { CLI_VERSION } from "./version";

export type CliCommand =
  | { kind: "run" }
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "logout" }
  | { kind: "mcp"; args: string[] }
  | { kind: "unknown"; arg: string };

export const HELP_TEXT = `
qronos-cli — autonomous AI coding agent in your terminal powered by Qronos AI.

Usage:
  qronos-cli                 start the coding agent
  qronos-cli --session <id>  resume a previous session
  qronos-cli logout          remove the stored sign-in token; the next run signs in again
  qronos-cli mcp <command>   add, remove, list, or sign in to your own MCP servers
                             (qronos-cli mcp --help for details)
  qronos-cli --version       print the CLI version
  qronos-cli --help          show this help

Environment:
  QRONOS_BASE_URL            override the backend base URL (default https://api.qronos.me)
  QRONOS_API_KEY             direct Qronos AI API key (sk_live_...)
  FREEPI_NO_AUTO_UPDATE      disable in-place self-update for this run
  FREEPI_NO_GRAVITY_PIXEL=1  do not run Gravity's ad-measurement pixel
`.trim();

export function versionLine(): string {
  return `qronos-cli ${CLI_VERSION}`;
}

/**
 * argv is process.argv.slice(2). Anything unrecognized — including trailing
 * args after a valid command — is { kind: "unknown" } so index.ts can show
 * help and exit nonzero, rather than silently ignoring input the way the
 * arg-less CLI used to (a typo'd `free-pi-cli loguot` must not quietly start
 * a full agent session and burn ad-funded tokens).
 */
export function parseCliArgs(argv: readonly string[]): CliCommand {
  const [first, ...rest] = argv;
  if (first === undefined) return { kind: "run" };

  // Everything after `mcp` belongs to pi's mcp command, so pass it through untouched.
  if (first === "mcp") return { kind: "mcp", args: rest };

  // run.ts reads and validates the value itself (incl. the missing-value message).
  if (first === "--session") {
    return rest.length > 1 ? { kind: "unknown", arg: rest[1] as string } : { kind: "run" };
  }

  let kind: "help" | "version" | "logout";
  if (first === "--help" || first === "-h" || first === "help") kind = "help";
  else if (first === "--version" || first === "-v") kind = "version";
  else if (first === "logout") kind = "logout";
  else return { kind: "unknown", arg: first };

  if (rest.length > 0) return { kind: "unknown", arg: rest[0] as string };
  return { kind };
}
