// Remembered endpoint connections, minus the secret.
//
// Design decision: **the API key does not go in this file by default.** People
// paste real keys into a CLI; writing them to plaintext JSON in a home
// directory is the most common way those keys leak (a synced dotfiles repo, a
// backup, a shared machine, a pasted `cat`). So a saved connection stores only
// the endpoint, the label and the model, and the key is read from the
// environment at startup.
//
// `inlineApiKey` exists because some people genuinely prefer it over env vars.
// It is opt-in per connection, the file is created 0600, and the value is never
// printed back to a log or an error message.

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface SavedConnection {
  /** Endpoint root, e.g. https://api.openai.com/v1 */
  baseUrl: string;
  /** Human label shown in the footer, e.g. "openai". */
  provider: string;
  /** Model id chosen at setup. */
  model: string;
  /**
   * Only present when the user explicitly chose to store the key. Never
   * echoed to output — see redactConnection().
   */
  inlineApiKey?: string;
}

export interface ConnectionFile {
  active?: string;
  connections: Record<string, SavedConnection>;
}

export const EMPTY_CONNECTION_FILE: ConnectionFile = { connections: {} };

/** Read the connection file. A missing or corrupt file reads as empty. */
export async function loadConnectionFile(path: string): Promise<ConnectionFile> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return { connections: {} };
    const obj = parsed as Record<string, unknown>;
    const connections: Record<string, SavedConnection> = {};
    const rawConnections = obj.connections;
    if (rawConnections && typeof rawConnections === "object") {
      for (const [key, value] of Object.entries(rawConnections as Record<string, unknown>)) {
        const c = coerceConnection(value);
        if (c) connections[key] = c;
      }
    }
    return {
      active: typeof obj.active === "string" ? obj.active : undefined,
      connections,
    };
  } catch {
    return { connections: {} };
  }
}

function coerceConnection(value: unknown): SavedConnection | undefined {
  if (!value || typeof value !== "object") return undefined;
  const o = value as Record<string, unknown>;
  if (typeof o.baseUrl !== "string" || o.baseUrl.trim() === "") return undefined;
  if (typeof o.provider !== "string" || o.provider.trim() === "") return undefined;
  return {
    baseUrl: o.baseUrl.trim(),
    provider: o.provider.trim(),
    model: typeof o.model === "string" ? o.model : "",
    inlineApiKey: typeof o.inlineApiKey === "string" && o.inlineApiKey ? o.inlineApiKey : undefined,
  };
}

/**
 * Write the connection file atomically enough for a CLI, at 0600.
 *
 * chmod is applied explicitly because writeFile's `mode` only governs newly
 * created files on some umasks; a re-save of an existing 0644 file would
 * otherwise stay world-readable.
 */
export async function saveConnectionFile(path: string, file: ConnectionFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

/** Store a connection and mark it active. */
export async function rememberConnection(
  path: string,
  connection: SavedConnection,
): Promise<ConnectionFile> {
  const file = await loadConnectionFile(path);
  file.connections[connection.provider] = connection;
  file.active = connection.provider;
  await saveConnectionFile(path, file);
  return file;
}

/** The connection marked active, if any. */
export function activeConnection(file: ConnectionFile): SavedConnection | undefined {
  if (!file.active) return undefined;
  return file.connections[file.active];
}

/**
 * Environment variables that might hold this connection's key, in priority
 * order. Derived from the provider label so the user's existing shell setup
 * keeps working.
 */
export function keyEnvNames(provider: string): string[] {
  const upper = provider.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  const names = [`${upper}_API_KEY`, "QRONOS_API_KEY", "OPENAI_API_KEY"];
  return Array.from(new Set(names.filter(Boolean)));
}

/** First non-empty key from the environment for this connection. */
export function keyFromEnv(provider: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const name of keyEnvNames(provider)) {
    const value = env[name];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return undefined;
}

/**
 * Resolve the key for a connection: inline (explicit opt-in) first, then env.
 * Returns undefined when neither is available.
 */
export function resolveConnectionKey(
  connection: SavedConnection,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (connection.inlineApiKey) return connection.inlineApiKey;
  return keyFromEnv(connection.provider, env);
}

/** A copy safe to print or log: the key is replaced by its env var name. */
export function redactConnection(connection: SavedConnection): Record<string, string> {
  const out: Record<string, string> = {
    provider: connection.provider,
    baseUrl: connection.baseUrl,
    model: connection.model,
  };
  out.apiKey = connection.inlineApiKey ? "<stored inline>" : `from $${keyEnvNames(connection.provider)[0]}`;
  return out;
}

/** Derive a short provider label from a base URL when the user does not type one. */
export function providerNameFromUrl(baseUrl: string): string {
  try {
    const host = new URL(baseUrl).hostname.replace(/^www\./, "");
    const parts = host.split(".");
    // api.openai.com -> openai; api.deepseek.com -> deepseek; localhost -> local
    if (parts[0] === "api" && parts.length >= 2) return parts[1] ?? host;
    if (host === "localhost" || host === "127.0.0.1") return "local";
    return parts.length >= 2 ? (parts[parts.length - 2] ?? host) : host;
  } catch {
    return "custom";
  }
}
