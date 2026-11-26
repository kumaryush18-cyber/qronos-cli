// Drawing a free-pi ad in the ad slot we already have.
//
// The slot is shared with our Gravity banner (`qronos-ad`), so there is only
// ever one ad above the editor. Which one shows is decided by the active model:
// a free-pi model gets a free-pi ad, everything else keeps the Gravity banner.
//
// The order in this file is the promise:
//   1. ask for an ad;
//   2. draw it;
//   3. only then fire the pixel and post the impression.
// A step that fails stops the chain — nothing is ever counted that was not
// drawn.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AdCreative } from "@qronos/shared";
import { isHttpUrl, type FreepiAd } from "./freepi-ads";
import type { FreepiAdSource } from "./freepi-ads-source";
import { adWidget } from "./vendor/pi-ads/clickable";
import { setWidgetSafely } from "./vendor/pi-ads/widget";

/** The same widget id the Gravity banner uses: one slot, one ad. */
export const FREEPI_BANNER_WIDGET_ID = "qronos-ad";

export interface FreepiBannerOptions {
  source: FreepiAdSource;
  /** Repeat the banner width floor the Gravity renderer keeps. */
  adMinColumns: number;
  /** Mirrors the shown ad's click URL out to /support; undefined clears it. */
  onBannerAd?: (clickUrl: string | undefined) => void;
  /** False after the session shut down: no side effects then. */
  isActive?: () => boolean;
  fetchImpl?: typeof fetch;
}

export interface FreepiBanner {
  render(ctx: ExtensionContext, context?: string): Promise<{ drawn: boolean; adsRequired: boolean }>;
  clear(ctx: ExtensionContext): void;
}

/** The creative shape the existing widget draws. A free-pi ad is one line. */
export function freepiCreative(ad: FreepiAd): AdCreative {
  return { headline: ad.line, body: "", cta: "", accent: "" };
}

/**
 * Fire a programmatic impression pixel, if the ad carries one.
 *
 * Fire and forget: a pixel that fails must not delay the chat or lose the ad
 * that is already on screen.
 */
export function firePixel(ad: FreepiAd, fetchImpl?: typeof fetch): boolean {
  if (!isHttpUrl(ad.impUrl)) return false;
  try {
    void Promise.resolve((fetchImpl ?? fetch)(ad.impUrl!, { method: "GET", signal: AbortSignal.timeout(3_000) })).catch(
      () => {},
    );
  } catch {
    return false;
  }
  return true;
}

export function createFreepiBanner(options: FreepiBannerOptions): FreepiBanner {
  const clear = (ctx: ExtensionContext) => {
    setWidgetSafely(ctx, FREEPI_BANNER_WIDGET_ID, undefined);
    options.onBannerAd?.(undefined);
  };

  return {
    clear,

    async render(ctx, context) {
      const result = await options.source.fetch("banner", context);
      if (options.isActive && !options.isActive()) return { drawn: false, adsRequired: result.adsRequired };

      if (!result.ad) {
        clear(ctx);
        return { drawn: false, adsRequired: result.adsRequired };
      }

      const ad = result.ad;
      setWidgetSafely(ctx, FREEPI_BANNER_WIDGET_ID, adWidget(freepiCreative(ad), ad.clickUrl ?? "", options.adMinColumns));
      options.onBannerAd?.(ad.clickUrl);
      firePixel(ad, options.fetchImpl);
      await options.source.drawn(ad);
      return { drawn: true, adsRequired: result.adsRequired };
    },
  };
}
