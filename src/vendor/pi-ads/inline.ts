// inline ad card after every `adInlineTurnFrequency`-th assistant turn
// (default 5), shown for exactly one turn, then cleared. Driven entirely
// from turn_end (see index.ts) — no turn_start hook needed: the card set at
// turn N's turn_end is cleared at the *next* turn_end before that turn's own
// cadence check runs, which is "visible for one turn" without adding a
// second hook to the extension's registered surface.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Config } from "@qronos/shared";
import type { AdsDeps } from "./api";
import { fetchAdNext, fireGravityImpression, postImpression } from "./api";
import type { AdScreen } from "./screen";
import { adWidget } from "./clickable";
import { setWidgetSafely } from "./widget";

export const INLINE_WIDGET_ID = "qronos-ad-inline";

export interface InlineRenderer {
  onTurnEnd(deps: AdsDeps, ctx: ExtensionContext, config: Config, prompt?: string): Promise<void>;
  /** Reset turn count / visibility — called on session_start so a /new or /resume starts cadence fresh. */
  reset(ctx: ExtensionContext): void;
}

export function createInlineRenderer(screen: AdScreen = {}): InlineRenderer {
  let turnCount = 0;
  let inlineVisible = false;
  let lastPostedToken: string | undefined;

  const clearInline = (ctx: ExtensionContext) => {
    if (inlineVisible) setWidgetSafely(ctx, INLINE_WIDGET_ID, undefined);
    inlineVisible = false;
    screen.inline = undefined;
  };

  return {
    async onTurnEnd(deps, ctx, config, prompt) {
      turnCount += 1;

      clearInline(ctx);

      if (turnCount % config.adInlineTurnFrequency !== 0) return;
      // A programmatic banner is on screen: no other ad (of any source) may appear beside it.
      if (screen.banner === "gravity" || screen.banner === "thrad") return;

      const ad = await fetchAdNext(deps, "inline", prompt);
      if (!ad) return;
      const isProgrammatic = ad.source === "gravity" || ad.source === "thrad";
      // The banner may have turned into a programmatic ad while this fetch was in flight.
      if ((screen as AdScreen).banner === "gravity" || (screen as AdScreen).banner === "thrad") return;
      if (isProgrammatic && screen.banner) screen.clearBanner?.();

      setWidgetSafely(ctx, INLINE_WIDGET_ID, adWidget(ad.creative, ad.click_url, config.adMinColumns), { placement: "belowEditor" });
      inlineVisible = true;
      screen.inline = isProgrammatic ? (ad.source as "gravity" | "thrad") : "own";
      screen.clearInline = () => clearInline(ctx);

      if (lastPostedToken !== ad.click_token) {
        lastPostedToken = ad.click_token;
        const impFired = fireGravityImpression(deps, ad);
        await postImpression(deps, ad.ad_id, ad.click_token, impFired);
      }
    },

    reset(ctx) {
      turnCount = 0;
      clearInline(ctx);
    },
  };
}
