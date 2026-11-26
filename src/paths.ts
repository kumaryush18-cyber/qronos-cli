import { homedir } from "node:os";
import { join } from "node:path";

// Fully separate from pi's own `~/.pi/agent` so an existing pi install (and
// its credentials/settings/sessions) is never touched by qronos-cli.
const QRONOS_DIR_NAME = ".qronos";

export function getQronosAgentDir(): string {
  return join(homedir(), QRONOS_DIR_NAME, "agent");
}

export function getCredentialsPath(agentDir: string = getQronosAgentDir()): string {
  return join(agentDir, "credentials.json");
}

/**
 * The free-pi token pool, `~/.qronos/agent/freepi.json`.
 *
 * Deliberately NOT `~/.free-pi`: that folder belongs to pi, and it is off
 * limits to our own tools. This file is ours, mode 600, and holds only the
 * tokens the user added plus one session id each.
 */
export function getFreepiTokensPath(agentDir: string = getQronosAgentDir()): string {
  return join(agentDir, "freepi.json");
}

/**
 * The free-pi model catalogue cache, `~/.qronos/agent/freepi-models.json`.
 *
 * Holds only model ids and their real context sizes, no secret of any kind.
 * Kept for an hour so a model list is not fetched on every launch.
 */
export function getFreepiCatalogPath(agentDir: string = getQronosAgentDir()): string {
  return join(agentDir, "freepi-models.json");
}

/** The last CLI version whose "what's new" the user has already seen. */
export function getLastSeenVersionPath(agentDir: string = getQronosAgentDir()): string {
  return join(agentDir, "last-seen-version");
}

/**
 * Saved endpoint connections, `~/.qronos/connections.json`.
 *
 * Separate from credentials.json because it holds no secret by default: it
 * records which endpoint/model the user picked, and the API key stays in the
 * environment.
 */
export function getConnectionsPath(): string {
  return join(homedir(), QRONOS_DIR_NAME, "connections.json");
}

/** The self-update opt-out config file, `~/.qronos/config.json`. Read-only — never created. */
export function getConfigPath(): string {
  return join(homedir(), QRONOS_DIR_NAME, "config.json");
}

/** User-level lifecycle hooks, `~/.qronos/hooks.json`. Read-only — never created. */
export function getHooksPath(): string {
  return join(homedir(), QRONOS_DIR_NAME, "hooks.json");
}

/** Project-level hooks, `<cwd>/.qronos/hooks.json`. */
export function getProjectHooksPath(cwd: string): string {
  return join(cwd, ".qronos", "hooks.json");
}

/** User-level memory, `~/.qronos/QRONOS.md`. */
export function getUserMemoryPath(): string {
  return join(homedir(), QRONOS_DIR_NAME, "QRONOS.md");
}
