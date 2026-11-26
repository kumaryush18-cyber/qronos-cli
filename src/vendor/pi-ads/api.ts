// Thin fetch layer shared by banner/inline/meter. Never throws: every ad or
// budget fetch failure resolves to `undefined` so the caller can clear the
// widget and move on — nothing here may block or delay the chat turn/
// requirement).
import { GRAVITY_CONTEXT_HEADER, type AdNextResponse, type AdSlot, type MeResponse } from "@qronos/shared";
import {
  AD_MESSAGES_HEADER,
  AD_USER_HASH_HEADER,
  cleanEmailHash,
  encodeMessagesHeader,
  userAgentFor,
  type AdMessage,
} from "../../ad-messages";

export interface AdsDeps {
  baseUrl: string;
  getToken: () => string | Promise<string>;
  /** Stable logical session id; omitted by older harness-only callers. */
  sessionId?: string;
  fetchImpl?: typeof fetch;
  /** Base64url Gravity context (already size-checked); sent on /ads/next only. Undefined = send nothing. */
  getGravityContext?: () => string | undefined;
  /** The client identity, so the gateway can report a real OS and user agent. */
  identity?: { version: string; os: string; arch: string };
  /** A pre-hashed account email (64 hex). Never the address itself. */
  getEmailHash?: () => string | undefined;
}

// "Never block the chat turn" needs a clock, not just a catch: a hung socket
// resolves neither way. Every caller below already maps a thrown error to
// `undefined`, so a timeout abort lands on the same path as any other failure.
// Above the server's 2.5 s Gravity wait, so a Gravity timeout still returns our own ad in time.
const REQUEST_TIMEOUT_MS = 5_000;

async function authedFetch(deps: AdsDeps, path: string, init?: RequestInit): Promise<Response> {
  const token = await deps.getToken();
  const doFetch = deps.fetchImpl ?? fetch;
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return doFetch(`${deps.baseUrl}${path}`, {
    ...init,
    signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
    headers: {
      ...(init?.headers ?? {}),
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      // x-session-id is a launch-time snapshot of the logical session; an in-TUI /new/resume change after launch is not reflected (known, out of scope).
      ...(deps.sessionId && (path.startsWith("/ads/next") || path === "/ads/impression")
        ? { "x-session-id": deps.sessionId }
        : {}),
      ...(path.startsWith("/ads/next") ? gravityHeader(deps) : {}),
      ...(path.startsWith("/ads/next")
        ? {
            "user-agent": userAgentFor(
              deps.identity ?? { version: "unknown", os: process.platform, arch: process.arch },
            ),
          }
        : {}),
      // Only a debug run asks the gateway why a slot came back empty.
      ...(path.startsWith("/ads/next") && process.env.QRONOS_DEBUG_ADS === "1" ? { "x-ad-debug": "1" } : {}),
    },
  });
}

/** The account email hash, if the caller has one. A failure sends nothing. */
function cleanHash(deps: AdsDeps): string | undefined {
  try {
    return cleanEmailHash(deps.getEmailHash?.());
  } catch {
    return undefined;
  }
}

function gravityHeader(deps: AdsDeps): Record<string, string> {
  try {
    const ctx = deps.getGravityContext?.();
    return ctx ? { [GRAVITY_CONTEXT_HEADER]: ctx } : {};
  } catch {
    return {};
  }
}

const IMP_TIMEOUT_MS = 3_000;

function isGravityImpUrl(raw: string | undefined): raw is string {
  if (!raw) return false;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:") return false;
    // A bare host is not an impression endpoint. Firing it would invent an
    // impression that never happened, which is worse than firing none.
    if (u.pathname === "/" && !u.search) return false;
    return /(^|\.)trygravity\.(ai|com)$/.test(u.hostname) || /(^|\.)thrad\.ai$/.test(u.hostname);
  } catch {
    return false;
  }
}

/**
 * Fires the programmatic impression pixel (Gravity or Thrad AI) from this machine.
 * Plain GET with no qronos credentials. Fire-and-forget: never awaited, errors swallowed.
 */
export function fireGravityImpression(deps: AdsDeps, ad: AdNextResponse): boolean {
  if ((ad.source !== "gravity" && ad.source !== "thrad") || !isGravityImpUrl(ad.imp_url)) return false;
  try {
    void Promise.resolve((deps.fetchImpl ?? fetch)(ad.imp_url, { method: "GET", signal: AbortSignal.timeout(IMP_TIMEOUT_MS) })).catch(() => {});
  } catch {
    // synchronous failure still counts as attempted
  }
  return true;
}

/** GET /ads/next — the real conversation rides in headers, not the URL. */
export async function fetchAdNext(
  deps: AdsDeps,
  slot: AdSlot,
  options: { prompt?: string; messages?: AdMessage[] } = {},
): Promise<AdNextResponse | undefined> {
  const debug = process.env.QRONOS_DEBUG_ADS === "1";
  try {
    const params = new URLSearchParams({ slot });
    if (options.prompt && options.prompt.trim()) {
      params.set("prompt", options.prompt.trim().slice(0, 500));
    }
    const messagesHeader = encodeMessagesHeader(options.messages ?? []);
    const emailHash = cleanHash(deps);
    const res = await authedFetch(deps, `/ads/next?${params.toString()}`, {
      headers: {
        ...(messagesHeader ? { [AD_MESSAGES_HEADER]: messagesHeader } : {}),
        ...(emailHash ? { [AD_USER_HASH_HEADER]: emailHash } : {}),
      },
    });
    if (res.status === 204 || !res.ok) {
      // One line, only with QRONOS_DEBUG_ADS=1: an empty slot is normal, but a
      // silent one makes "no fill here" and "the feature is broken" look the same.
      if (debug) {
        // The gateway sends its own reason when asked; it is the shortest path to
        // "the key is sandbox" instead of a guess.
        const why = res.headers.get("x-ad-miss");
        console.error(
          `qronos-cli: ad ${slot} -> ${res.status}${res.status === 204 ? " (no fill)" : ""} from ${deps.baseUrl}` +
            (why ? ` · ${why}` : ""),
        );
      }
      return undefined;
    }
    if (debug) console.error(`qronos-cli: ad ${slot} -> ${res.status} from ${deps.baseUrl}`);
    return (await res.json()) as AdNextResponse;
  } catch (error) {
    if (debug) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`qronos-cli: ad ${slot} -> failed (${message.slice(0, 120)}) from ${deps.baseUrl}`);
    }
    return undefined;
  }
}

/** POST /ads/impression. Best-effort tracking — failures are swallowed. */
export async function postImpression(deps: AdsDeps, ad: AdNextResponse, impFired = false): Promise<void> {
  try {
    await authedFetch(deps, "/ads/impression", {
      method: "POST",
      body: JSON.stringify({
        ad_id: ad.ad_id,
        click_token: ad.click_token,
        placement: ad.placement ?? "unknown",
        source: ad.source,
        ...(impFired ? { imp_fired: true } : {}),
      }),
    });
  } catch {
    // best-effort; never block chat on tracking failure
  }
}

/** GET /me. Any failure resolves to undefined so the meter widget clears instead of showing stale data. */
export async function fetchMe(deps: AdsDeps): Promise<MeResponse | undefined> {
  try {
    const res = await authedFetch(deps, "/me");
    if (!res.ok) return undefined;
    return (await res.json()) as MeResponse;
  } catch {
    return undefined;
  }
}
