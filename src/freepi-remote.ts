// The free-pi token pool, as the qronos gateway serves it.
//
// Why remote: a token file dies with the machine that holds it, so the pool now
// lives in the qronos-ai admin panel and every signed-in CLI can read it. This
// module is the only place that knows that URL and shape.
//
// Rules kept here:
//  - the token is never logged, never written to disk and never put in an error;
//  - a bad reply is *no tokens*, not a crash and not a half-filled pool;
//  - the request carries the user's own qronos key, nothing else.

import type { FreepiTokenRecord } from "./freepi-tokens";
import { makeTokenRecord } from "./freepi-tokens";

/** Where the gateway serves the pool. */
export const FREEPI_REMOTE_PATH = "/api/cli/freepi/tokens";

/** More than the admin panel can hold, so a broken server cannot flood the CLI. */
export const FREEPI_REMOTE_MAX_TOKENS = 16;

/** Shorter than any real free-pi token. */
const MIN_TOKEN_LENGTH = 20;

export type RemotePoolResult =
  | { ok: true; tokens: string[] }
  | { ok: false; reason: "no-key" | "unauthorized" | "empty" | "unreachable" | "bad-shape"; message: string };

export interface RemotePoolOptions {
  baseUrl: string;
  jwt?: string | null;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Pull the token list from the gateway.
 *
 * Never throws: the CLI must always start, so every failure becomes
 * `{ ok: false }` with one plain sentence.
 */
export async function fetchRemoteFreepiTokens(options: RemotePoolOptions): Promise<RemotePoolResult> {
  const jwt = (options.jwt ?? "").trim();
  if (!jwt) {
    return { ok: false, reason: "no-key", message: "Not signed in, so the shared pool is unavailable." };
  }
  const url = `${options.baseUrl.replace(/\/+$/, "")}${FREEPI_REMOTE_PATH}`;
  const doFetch = options.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await doFetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${jwt}`, Accept: "application/json" },
      signal: AbortSignal.timeout(options.timeoutMs ?? 8_000),
    });
  } catch {
    return { ok: false, reason: "unreachable", message: "Could not reach Qronos for the shared pool." };
  }

  if (response.status === 401 || response.status === 403) {
    return {
      ok: false,
      reason: "unauthorized",
      message: "Qronos did not accept this key, so the shared pool is unavailable.",
    };
  }
  if (response.status === 503) {
    // The server already wrote a good sentence for this case.
    const text = await safeJson(response);
    const sentence = typeof text?.error === "string" ? text.error.trim() : "";
    return {
      ok: false,
      reason: "empty",
      message: sentence || "No model key is available right now.",
    };
  }
  if (!response.ok) {
    return { ok: false, reason: "unreachable", message: `Qronos answered ${response.status} for the shared pool.` };
  }

  const body = await safeJson(response);
  const tokens = readTokenList(body);
  if (!tokens || tokens.length === 0) {
    return { ok: false, reason: "bad-shape", message: "Qronos sent no usable free-pi token." };
  }
  return { ok: true, tokens };
}

async function safeJson(response: Response): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed = await response.json();
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The token strings, or undefined when the reply is not the shape we agreed on.
 *
 * Every field is checked: one odd entry drops the whole reply, because a partly
 * trusted pool is worse than none.
 */
export function readTokenList(body: unknown): string[] | undefined {
  if (!body || typeof body !== "object") return undefined;
  const list = (body as { tokens?: unknown }).tokens;
  if (!Array.isArray(list)) return undefined;
  const out: string[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") return undefined;
    const token = (entry as { token?: unknown }).token;
    if (typeof token !== "string") return undefined;
    const trimmed = token.trim();
    if (trimmed.length < MIN_TOKEN_LENGTH) return undefined;
    if (/\s/.test(trimmed)) return undefined;
    if (!out.includes(trimmed)) out.push(trimmed);
    if (out.length >= FREEPI_REMOTE_MAX_TOKENS) break;
  }
  return out;
}

/**
 * Turn a server reply into pool records.
 *
 * Ids start with `srv-`, so they can never collide with the `t1`-style ids a
 * saved file uses, and a remote token is never written back to disk.
 */
export function remoteRecords(tokens: readonly string[], label?: string): FreepiTokenRecord[] {
  const records: FreepiTokenRecord[] = [];
  for (const token of tokens) {
    const record = makeTokenRecord(token, records, label?.trim() || "server");
    records.push({ ...record, id: `srv-${records.length + 1}` });
  }
  return records;
}

/**
 * Save one token into the shared pool.
 *
 * Called right after a successful login, so a new machine needs no copy-paste.
 * Rules kept here:
 *  - never throws: a login must not fail because the upload failed;
 *  - no retry: a retried write could fill two slots;
 *  - the reply is a slot number and six fingerprint characters, nothing else;
 *  - the token is never logged and never put in a message.
 */
export type RemoteSaveResult =
  | { ok: true; slot: number; fingerprint: string; duplicate: boolean }
  | {
      ok: false;
      reason: "no-key" | "unauthorized" | "invalid" | "full" | "unreachable" | "bad-shape";
      message: string;
    };

export interface RemoteSaveOptions {
  baseUrl: string;
  jwt?: string | null;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export async function postRemoteFreepiToken(
  token: string,
  options: RemoteSaveOptions,
): Promise<RemoteSaveResult> {
  const jwt = (options.jwt ?? "").trim();
  if (!jwt) {
    return { ok: false, reason: "no-key", message: "Not signed in to Qronos, so the token was not shared." };
  }
  const value = token.trim();
  if (value.length < MIN_TOKEN_LENGTH) {
    return { ok: false, reason: "invalid", message: "That token is too short to share." };
  }
  const url = `${options.baseUrl.replace(/\/+$/, "")}${FREEPI_REMOTE_PATH}`;
  const doFetch = options.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await doFetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ token: value, label: "login" }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });
  } catch {
    return { ok: false, reason: "unreachable", message: "Could not reach Qronos to share the token." };
  }

  if (response.status === 401 || response.status === 403) {
    return { ok: false, reason: "unauthorized", message: "Qronos did not accept this key, so the token was not shared." };
  }

  let body: Record<string, unknown> | undefined;
  try {
    body = await safeJson(response);
  } catch {
    body = undefined;
  }

  if (response.status === 409) {
    const sentence = typeof body?.error === "string" ? body.error.trim() : "";
    return { ok: false, reason: "full", message: sentence || "The shared free-pi pool is full." };
  }
  if (response.status === 400) {
    const sentence = typeof body?.error === "string" ? body.error.trim() : "";
    return { ok: false, reason: "invalid", message: sentence || "free-pi refused this token." };
  }
  if (!response.ok) {
    return { ok: false, reason: "unreachable", message: `Qronos answered ${response.status} for the pool.` };
  }

  const slot = Number(body?.slot);
  const fingerprint = typeof body?.fingerprint === "string" ? body.fingerprint.trim() : "";
  if (!Number.isInteger(slot) || slot < 0) {
    return { ok: false, reason: "bad-shape", message: "Qronos sent no usable slot number." };
  }
  return {
    ok: true,
    slot,
    fingerprint: /^[a-f0-9]{6}$/i.test(fingerprint) ? fingerprint : "",
    duplicate: body?.duplicate === true,
  };
}
