// Client heartbeat for the Qronos admin panel.
//
// Two things the gateway cannot see on its own:
//   1. who is running the terminal client right now
//   2. which custom provider (BYOK) a user configured, and which model it uses
//
// BYOK calls go straight from this machine to that provider, so nothing about
// them reaches api.qronos.me. This module reports the minimum needed for
// support: the endpoint, the model, and a masked key (first two + last four)
// plus a sha256 fingerprint. The key itself never leaves the machine.
//
// Opt out with QRONOS_NO_TELEMETRY=1.
import { createHash } from "node:crypto";
import { hostname, homedir, platform, arch, release } from "node:os";
import { userInfo } from "node:os";

import { loadConnectionFile, activeConnection, resolveConnectionKey, type SavedConnection } from "./connection-store";
import { loadJwt } from "./credentials";
import { getConnectionsPath, getCredentialsPath } from "./paths";
import { CLI_VERSION } from "./version";

const REPORT_PATH = "/api/client/report";
const HEARTBEAT_MS = 5 * 60 * 1000;
const TIMEOUT_MS = 4000;

interface ByokPayload {
  providerId: string;
  baseUrl?: string;
  modelId?: string;
  keyMasked?: string;
  keyFingerprint?: string;
  source?: string;
}

function reportOrigin(): string {
  const explicit = process.env.QRONOS_API_ORIGIN?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const connection = process.env.QRONOS_BASE_URL?.trim();
  if (connection) {
    try {
      return new URL(connection).origin;
    } catch {
      // fall through to the default
    }
  }
  return "https://api.qronos.me";
}

/** A stable id for this machine, so one user keeps one row per device. */
function deviceId(): string {
  const seed = `${hostname()}|${userInfo().username}|${homedir()}`;
  return createHash("sha256").update(seed).digest("hex").slice(0, 40);
}

/** First two and last four characters. Enough to recognise, useless to reuse. */
function maskKey(key: string | undefined): string | undefined {
  if (!key) return undefined;
  const trimmed = key.trim();
  if (trimmed.length < 8) return undefined;
  return `${trimmed.slice(0, 2)}\u2026${trimmed.slice(-4)}`;
}

function fingerprintKey(key: string | undefined): string | undefined {
  if (!key) return undefined;
  return createHash("sha256").update(key.trim()).digest("hex").slice(0, 16);
}

function byokEntry(providerId: string, connection: SavedConnection): ByokPayload {
  const key = resolveConnectionKey(connection);
  return {
    providerId,
    baseUrl: connection.baseUrl,
    modelId: connection.model,
    keyMasked: maskKey(key),
    keyFingerprint: fingerprintKey(key),
    source: connection.inlineApiKey ? "inline" : key ? "env" : "none",
  };
}

async function buildPayload() {
  const file = await loadConnectionFile(getConnectionsPath()).catch(() => ({ connections: {} }));
  const active = activeConnection(file);
  const entries: ByokPayload[] = [];
  for (const [id, connection] of Object.entries(file.connections)) {
    // A connection pointing at the Qronos gateway is managed traffic, not BYOK.
    if (/api\.qronos\.me/i.test(connection.baseUrl)) continue;
    entries.push(byokEntry(id, connection));
  }
  const managed = active ? /api\.qronos\.me/i.test(active.baseUrl) : true;
  const mode = entries.length === 0 ? "managed" : managed ? "mixed" : "byok";
  return {
    client: "cli" as const,
    version: CLI_VERSION,
    os: platform(),
    arch: arch(),
    editorVersion: undefined,
    device: deviceId(),
    mode,
    modelId: active?.model,
    provider: active?.provider,
    byok: entries.slice(0, 8),
    kernel: release(),
  };
}

/** True when the heartbeat is allowed to run. */
export function telemetryEnabled(): boolean {
  return process.env.QRONOS_NO_TELEMETRY !== "1" && process.env.CI !== "true";
}

async function authToken(): Promise<string | undefined> {
  const connectionFile = await loadConnectionFile(getConnectionsPath()).catch(() => ({ connections: {} }));
  const active = activeConnection(connectionFile);
  const managedKey = active && /api\.qronos\.me/i.test(active.baseUrl) ? resolveConnectionKey(active) : undefined;
  if (managedKey) return managedKey;
  const jwt = await loadJwt(getCredentialsPath()).catch(() => null);
  return jwt ?? undefined;
}

/** Send one heartbeat. Never throws, never blocks the CLI. */
export async function reportClientOnce(): Promise<boolean> {
  if (!telemetryEnabled()) return false;
  try {
    const token = await authToken();
    if (!token) return false;
    const payload = await buildPayload();
    const response = await fetch(`${reportOrigin()}${REPORT_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "x-qronos-client": "cli",
        "user-agent": `Qronos-CLI/${CLI_VERSION}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}

let timer: NodeJS.Timeout | undefined;

/** Start the 5-minute heartbeat. Safe to call twice. */
export function startClientReport(): void {
  if (!telemetryEnabled() || timer) return;
  void reportClientOnce();
  timer = setInterval(() => void reportClientOnce(), HEARTBEAT_MS);
  timer.unref?.();
}

export function stopClientReport(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = undefined;
}
