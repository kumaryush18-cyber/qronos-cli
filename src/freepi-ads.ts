// free-pi's ad endpoints: ask for one ad, and count it only after it was seen.
//
// Two rules, both about honesty:
//   1. `204` means "no ad". Nothing is drawn and nothing is counted.
//   2. An impression is sent ONLY when the caller says the ad was really drawn
//      (`impFired: true`). A request nobody saw is fraud, and it is also the
//      fastest way to have the free tier taken away.
//
// Reading the answer is forgiving: free-pi's exact field names are verified
// against the real service later, so an unknown shape means "no ad" instead of
// a broken frame or a crash. `QRONOS_DEBUG_FREEPI_ADS=1` prints why.
import type { ClientIdentity } from "./ad-client-headers";
import { adRequestHeaders } from "./ad-client-headers";
import type { TokenLease } from "./freepi-tokens";

export type FreepiAdSlot = "banner" | "inline";

export interface FreepiAd {
  adId: string;
  clickToken: string;
  /** The one line to draw. Already cleaned: no colours, no control codes. */
  line: string;
  clickUrl?: string;
  /** A programmatic impression pixel, when the ad has one. */
  impUrl?: string;
}

export interface FreepiAdsDeps {
  /** `https://api.freepi.ai` — no `/v1`, the ad routes live at the root. */
  baseUrl: string;
  identity: ClientIdentity;
  /** Take a token for this call. The lease is released by the caller. */
  acquire: () => Promise<TokenLease | undefined>;
  release: (lease: TokenLease, status?: number) => void;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Debug switch: `QRONOS_DEBUG_FREEPI_ADS=1`. */
  debug?: boolean;
}

export interface AdNextResult {
  ad?: FreepiAd;
  /** The server says impressions are not being counted — surface it, never hide it. */
  adsRequired: boolean;
  /** False when the server never mentioned `ads_required`, so nobody clears an old warning. */
  adsRequiredKnown: boolean;
  /** Why no ad was drawn. For the debug switch only. */
  note?: string;
}

const DEFAULT_TIMEOUT_MS = 5_000;
/** What to draw when the ad has a headline but no URL: there is nothing to draw. */
const PORTION_CUT = 120;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function firstText(source: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = text(source[key]);
    if (value) return value;
  }
  return undefined;
}

/** Only http(s) may ever reach a browser. */
export function isHttpUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

/** Reduce any text to one clean line of at most 120 characters. */
export function adLine(raw: string): string {
  // eslint-disable-next-line no-control-regex
  const plain = raw.replace(/\u001b\[[0-9;]*m/g, "").replace(/[\u0000-\u001f\u007f]/g, " ");
  const line = plain.replace(/\s+/g, " ").trim();
  return line.length <= PORTION_CUT ? line : `${line.slice(0, PORTION_CUT - 1).trimEnd()}…`;
}

/**
 * Read one ad out of whatever the server sent.
 *
 * A different field name is not an error here: it means we do not know how to
 * draw that ad yet. Returning undefined keeps the slot empty on purpose.
 */
export function normalizeFreepiAd(payload: unknown): FreepiAd | undefined {
  const outer = record(payload);
  if (!outer) return undefined;
  // Some services nest the creative: { ad: { ... } }.
  const inner = record(outer.ad) ?? outer;
  const adId = firstText(inner, ["ad_id", "adId", "id"]) ?? firstText(outer, ["ad_id", "adId"]);
  const clickToken = firstText(inner, ["click_token", "clickToken", "impression_token", "token"]) ??
    firstText(outer, ["click_token", "clickToken"]);
  const line = firstText(inner, ["headline", "title", "text", "body", "copy"]) ??
    firstText(outer, ["headline", "title", "text"]);
  if (!adId || !clickToken || !line) return undefined;
  const clickUrl = firstText(inner, ["click_url", "clickUrl", "url", "link"]);
  const impUrl = firstText(inner, ["imp_url", "impUrl", "impression_url"]);
  return {
    adId,
    clickToken,
    line: adLine(line),
    ...(isHttpUrl(clickUrl) ? { clickUrl } : {}),
    ...(isHttpUrl(impUrl) ? { impUrl } : {}),
  };
}

/** `ads_required` may arrive at the top level or under `ad`. */
export function readAdsRequired(payload: unknown): boolean {
  return readAdsRequiredFlag(payload) === true;
}

/**
 * The same question, but `undefined` when the server said nothing about it.
 *
 * The difference matters: an answer that never mentions `ads_required` must
 * not clear a warning the server did give earlier. Only a real `false` clears
 * it.
 */
export function readAdsRequiredFlag(payload: unknown): boolean | undefined {
  const outer = record(payload);
  if (!outer) return undefined;
  if (typeof outer.ads_required === "boolean") return outer.ads_required;
  const inner = record(outer.ad);
  return typeof inner?.ads_required === "boolean" ? inner.ads_required : undefined;
}

function authHeaders(deps: FreepiAdsDeps, lease: TokenLease, context?: string): Record<string, string> {
  return {
    ...adRequestHeaders({ identity: deps.identity, sessionId: lease.sessionId, adContext: context }),
    Authorization: `Bearer ${lease.token}`,
    Accept: "application/json",
  };
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

/**
 * Ask for one ad.
 *
 * The token is released with the HTTP status, so a 429 parks it exactly like a
 * model request would — an ad call is still a request against the same limit.
 */
export async function fetchFreepiAd(
  deps: FreepiAdsDeps,
  slot: FreepiAdSlot,
  context?: string,
): Promise<AdNextResult> {
  const lease = await deps.acquire();
  if (!lease) return { adsRequired: false, adsRequiredKnown: false, note: "no free token" };
  const doFetch = deps.fetchImpl ?? fetch;
  let status: number | undefined;
  try {
    const url = `${deps.baseUrl}/ads/next?slot=${encodeURIComponent(slot)}`;
    const response = await doFetch(url, {
      method: "GET",
      headers: authHeaders(deps, lease, context),
      signal: AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    status = response.status;
    if (response.status === 204) return { adsRequired: false, adsRequiredKnown: false, note: "204 no ad" };
    if (!response.ok) {
      return { adsRequired: false, adsRequiredKnown: false, note: `http ${response.status}` };
    }
    const payload = await readJson(response);
    const flag = readAdsRequiredFlag(payload);
    const adsRequired = flag === true;
    const ad = normalizeFreepiAd(payload);
    if (!ad) return { adsRequired, adsRequiredKnown: flag !== undefined, note: "unknown ad shape" };
    return { ad, adsRequired, adsRequiredKnown: flag !== undefined };
  } catch (error) {
    status = status ?? undefined;
    return { adsRequired: false, adsRequiredKnown: false, note: `fetch failed: ${(error as Error).message}` };
  } finally {
    deps.release(lease, status);
  }
}

export interface ImpressionResult {
  ok: boolean;
  adsRequired: boolean;
  /** False when the server never mentioned `ads_required` in this answer. */
  adsRequiredKnown?: boolean;
  /** True when nothing was sent because the ad was never drawn. */
  skipped?: boolean;
}

/**
 * Count one impression — only for an ad that was really drawn.
 *
 * `impFired` is not a courtesy flag: when it is false the function sends
 * nothing at all, because an impression is a claim that someone saw it.
 */
export async function sendFreepiImpression(
  deps: FreepiAdsDeps,
  ad: Pick<FreepiAd, "adId" | "clickToken">,
  options: { impFired: boolean },
): Promise<ImpressionResult> {
  if (!options.impFired) return { ok: false, adsRequired: false, adsRequiredKnown: false, skipped: true };
  const lease = await deps.acquire();
  if (!lease) return { ok: false, adsRequired: false, adsRequiredKnown: false };
  const doFetch = deps.fetchImpl ?? fetch;
  let status: number | undefined;
  try {
    const response = await doFetch(`${deps.baseUrl}/ads/impression`, {
      method: "POST",
      headers: { ...authHeaders(deps, lease), "Content-Type": "application/json" },
      body: JSON.stringify({ ad_id: ad.adId, click_token: ad.clickToken, imp_fired: true }),
      signal: AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    status = response.status;
    const payload = response.ok ? await readJson(response) : undefined;
    const flag = readAdsRequiredFlag(payload);
    return { ok: response.ok, adsRequired: flag === true, adsRequiredKnown: flag !== undefined };
  } catch {
    return { ok: false, adsRequired: false, adsRequiredKnown: false };
  } finally {
    deps.release(lease, status);
  }
}
