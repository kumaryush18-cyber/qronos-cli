// The free-pi ad source: one place that fetches an ad and counts it, so the
// "drawn first, counted second" rule lives in one small file.
//
// The source holds three pieces of state on purpose:
//   - the last click token an impression was sent for, so a repaint of the same
//     ad never posts twice;
//   - whether the server said `ads_required`, so the UI can show it;
//   - nothing else. No timers, no drawing, no browser: those belong to the
//     banner widget, which is already tested on its own.
import type { ClientIdentity } from "./ad-client-headers";
import { fetchFreepiAd, sendFreepiImpression, type FreepiAd, type FreepiAdSlot } from "./freepi-ads";
import type { FreepiTokenPool } from "./freepi-tokens";
import { FREEPI_ROOT_URL } from "./freepi-models";

export interface FreepiAdSourceOptions {
  /** Resolved lazily, so a launch never waits on a file read. */
  getPool: () => Promise<FreepiTokenPool>;
  identity: ClientIdentity;
  /** `https://api.freepi.ai` (no `/v1`) by default. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  debug?: boolean;
  /** Called whenever the server says impressions are not counted. */
  onAdsRequired?: (value: boolean) => void;
}

export interface FreepiAdSource {
  /** Ask for one ad. Never throws: no ad is an answer. */
  fetch(slot: FreepiAdSlot, context?: string): Promise<{ ad?: FreepiAd; adsRequired: boolean; adsRequiredKnown: boolean }>;
  /** Count the ad that is now on screen. Repaints of the same ad are not recounted. */
  drawn(ad: FreepiAd): Promise<{ ok: boolean; adsRequired: boolean; skipped?: boolean }>;
  /** Latest known answer to "does free-pi want more ads?". */
  adsRequired(): boolean;
  /** Forget the dedupe state; a new turn may show a new ad. */
  reset(): void;
}

export function createFreepiAdSource(options: FreepiAdSourceOptions): FreepiAdSource {
  let lastPostedToken: string | undefined;
  let adsRequired = false;

  /** `QRONOS_DEBUG_ADS=1` covers both ad systems; the older flag still works. */
  const debugEnabled = (explicit?: boolean): boolean =>
    explicit ?? (process.env.QRONOS_DEBUG_ADS === "1" || process.env.QRONOS_DEBUG_FREEPI_ADS === "1");

  const deps = async () => {
    const pool = await options.getPool();
    return {
      baseUrl: options.baseUrl ?? FREEPI_ROOT_URL,
      identity: options.identity,
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
      debug: options.debug,
      acquire: async () => pool.acquire(),
      release: (lease: { tokenId: string }, status?: number) => pool.release(lease.tokenId, { status }),
    };
  };

  const note = (value: boolean) => {
    if (value === adsRequired) return;
    adsRequired = value;
    try {
      options.onAdsRequired?.(value);
    } catch {
      // A listener must never break an ad fetch.
    }
  };

  return {
    async fetch(slot, context) {
      const settings = await deps();
      const result = await fetchFreepiAd(settings, slot, context);
      if (result.adsRequiredKnown) note(result.adsRequired);
      // One line, only with `QRONOS_DEBUG_ADS=1` (or the older free-pi switch), so
      // an empty slot can be told apart from a broken one.
      if (debugEnabled(settings.debug)) {
        const why = result.ad ? `drew ${result.ad.adId}` : (result.note ?? "no ad");
        console.error(`qronos-cli: free ad ${slot} -> ${why}`);
      }
      return {
        ...(result.ad ? { ad: result.ad } : {}),
        adsRequired: result.adsRequired,
        adsRequiredKnown: result.adsRequiredKnown,
      };
    },
    async drawn(ad) {
      if (lastPostedToken === ad.clickToken) return { ok: true, adsRequired, skipped: true };
      const result = await sendFreepiImpression(await deps(), ad, { impFired: true });
      if (result.ok) lastPostedToken = ad.clickToken;
      if (result.adsRequiredKnown) note(result.adsRequired);
      return { ok: result.ok, adsRequired: result.adsRequired };
    },
    adsRequired: () => adsRequired,
    reset: () => {
      lastPostedToken = undefined;
    },
  };
}

/** The one-line status text for `/freepi list`, or undefined when all is well. */
export function adsRequiredText(adsRequired: boolean): string | undefined {
  if (!adsRequired) return undefined;
  return "The upstream service says ad impressions are not being counted (ads_required). Ads still show, but the daily allowance may pause until they count.";
}
