// The hashed email, fetched once and cached.
//
// Gravity's ops team: "0% of your requests send us your user's hashed email —
// the more we can attribute from your platform, the more the engine rewards
// your inventory." So the CLI asks our own gateway for the hash (the gateway
// hashes, we never hold an address), caches it for half an hour, and hands it
// to the Gravity pixel context and to the ad request header.
//
// Rules kept here:
//   - the raw email never exists on this machine;
//   - only a 64-character hex digest is accepted;
//   - a failure is silence, never a startup delay;
//   - `QRONOS_NO_AD_ATTRIBUTION=1` turns it off completely.

import { cleanEmailHash } from "./ad-messages";

/** Half an hour: an email does not change mid-session. */
export const EMAIL_HASH_TTL_MS = 30 * 60 * 1000;

export interface EmailHashDeps {
  baseUrl: string;
  getToken: () => string | Promise<string>;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

let cached: { value: string; at: number } | undefined;

/** Test seam: forget the cached hash. */
export function resetEmailHashCache(): void {
  cached = undefined;
}

export function attributionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.QRONOS_NO_AD_ATTRIBUTION !== "1";
}

/**
 * Reads `/me` once per TTL and returns the hash. Never throws: an offline
 * machine simply sends no identity.
 */
export async function fetchEmailHash(deps: EmailHashDeps): Promise<string | undefined> {
  const now = deps.now ?? Date.now;
  if (cached && now() - cached.at < EMAIL_HASH_TTL_MS) return cached.value;
  try {
    const token = await deps.getToken();
    const doFetch = deps.fetchImpl ?? fetch;
    const res = await doFetch(`${deps.baseUrl}/me`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(4_000),
    });
    if (!res.ok) return cached?.value;
    const body = (await res.json()) as { email_hash?: unknown };
    const hash = cleanEmailHash(body?.email_hash);
    if (!hash) {
      cached = undefined;
      return undefined;
    }
    cached = { value: hash, at: now() };
    return hash;
  } catch {
    return cached?.value;
  }
}

/**
 * A getter the ads extension can call synchronously, while a started fetch
 * fills it in the background. This is why a slow `/me` never delays the first
 * ad slot: the first request goes without identity, the next one carries it.
 */
export function startEmailHash(
  deps: EmailHashDeps,
  env: NodeJS.ProcessEnv = process.env,
): (() => string | undefined) | undefined {
  if (!attributionEnabled(env)) return undefined;
  let value: string | undefined;
  void fetchEmailHash(deps)
    .then((hash) => {
      value = hash;
    })
    .catch(() => {});
  return () => value;
}
