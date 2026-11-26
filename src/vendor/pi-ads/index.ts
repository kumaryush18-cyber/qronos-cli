// pi extension entry point.: this extension registers only
// lifecycle/UI hooks (session_start, turn_end, session_shutdown) — never
// context, before_provider_request, before_agent_start, message_*, tool_*,
// or agent_*. See src/sandbox.test.ts for the enforced proof. Ad content
// only ever reaches the terminal through ctx.ui.setWidget; it never touches
// qronos.sendMessage / qronos.sendUserMessage / qronos.appendEntry / the session.
import type { ExtensionAPI, ExtensionContext, InlineExtension } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "@qronos/shared";
import { messagesFromBranch, type AdMessage } from "../../ad-messages";
import type { AdsDeps } from "./api";
import { createBannerRenderer } from "./banner";
import { createInlineRenderer } from "./inline";
import type { AdScreen } from "./screen";
import { renderMeter } from "./meter";
import { createFreepiAdSource } from "../../freepi-ads-source";
import { createFreepiBanner, type FreepiBanner } from "../../freepi-ads-banner";

export interface CreateAdsExtensionOptions {
  baseUrl: string;
  /** Reads the current JWT from the cli's credential store. May be async. */
  getToken: () => string | Promise<string>;
  sessionId: string;
  fetchImpl?: typeof fetch;
  /** The real client identity, so the gateway can report a true OS and user agent. */
  identity?: import("../../ad-client-headers").ClientIdentity;
  /** A pre-hashed account email (64 hex) for Gravity attribution. Never the address. */
  getEmailHash?: () => string | undefined;
  /** Base64url Gravity context for the /ads/next header; undefined result = header omitted. */
  getGravityContext?: () => string | undefined;
 /**: mirrors the currently-shown banner ad's click URL to the caller
   * (qronos-cli's /support command) — undefined when no ad is shown. */
  onBannerAd?: (clickUrl: string | undefined) => void;
  /**
   * F3: the free-pi banner, used instead of the Gravity one while a free-pi
   * model is active. Optional: without tokens there is no free-pi ad to show.
   */
  freepi?: {
    /** The shared token pool, resolved on first use. */
    getPool: () => Promise<import("../../freepi-tokens").FreepiTokenPool>;
    identity: import("../../ad-client-headers").ClientIdentity;
    /** True while the active model is one of the four free models. */
    isActiveModel: (ctx: ExtensionContext) => boolean;
    fetchImpl?: typeof fetch;
    onAdsRequired?: (value: boolean) => void;
    /** Seam: the ad source, so a test needs no token pool. */
    source?: import("../../freepi-ads-source").FreepiAdSource;
  };
}

// Idle fallback refresh, plus a per-step refresh on turn_end capped at one
// banner render per BANNER_MIN_REFRESH_MS (measured from the last render).
const BANNER_REFRESH_MS = 10 * 60 * 1000;
const BANNER_MIN_REFRESH_MS = 60 * 1000;

/** Init function the cli calls with baseUrl + a token getter, decoupled from any credential-store detail. */
export function createAdsExtension(opts: CreateAdsExtensionOptions): InlineExtension {
  const deps: AdsDeps = {
    baseUrl: opts.baseUrl,
    getToken: opts.getToken,
    sessionId: opts.sessionId,
    fetchImpl: opts.fetchImpl,
    getGravityContext: opts.getGravityContext,
    identity: opts.identity,
    getEmailHash: opts.getEmailHash,
  };
  const config = loadConfig();
  // Built once per launch: one dedupe state, one ads_required flag.
  const freepiBanner: FreepiBanner | undefined = opts.freepi
    ? createFreepiBanner({
        source:
          opts.freepi.source ??
          createFreepiAdSource({
            getPool: opts.freepi.getPool,
            identity: opts.freepi.identity,
            fetchImpl: opts.freepi.fetchImpl,
            onAdsRequired: opts.freepi.onAdsRequired,
          }),
        adMinColumns: config.adMinColumns,
        onBannerAd: opts.onBannerAd,
        fetchImpl: opts.freepi.fetchImpl,
      })
    : undefined;

  return {
    name: "qronos-ads",
    factory(qronos: ExtensionAPI) {
      let stopped = false;
      const screen: AdScreen = {};
      const banner = createBannerRenderer({ onBannerAd: opts.onBannerAd, isActive: () => !stopped, screen });
      const inline = createInlineRenderer(screen);
      // Timers are session-scoped resources: started in session_start, torn
      // down in session_shutdown, per pi's own extension guidance (never
      // started from the factory itself).
      let bannerInterval: ReturnType<typeof setInterval> | undefined;
      let lastBannerAt = 0;
      let bannerInFlight = false;
      // Every trigger shares one throttle: skip while a render is pending or
      // the last one finished under BANNER_MIN_REFRESH_MS ago. session_start
      // forces a render.
      /** True only when a free-pi model is the active one. */
      const isFreepiModel = (ctx: ExtensionContext): boolean =>
        Boolean(opts.freepi && freepiBanner && opts.freepi.isActiveModel(ctx));

      const renderBanner = async (
        ctx: ExtensionContext,
        force = false,
        context: { prompt?: string; messages?: AdMessage[] } = {},
      ) => {
        if (stopped) return;
        if (!force && (bannerInFlight || Date.now() - lastBannerAt < BANNER_MIN_REFRESH_MS)) return;
        bannerInFlight = true;
        try {
          // One rule decides which ad shows, and it is the active model:
          //  - a free-pi model gets a free-pi ad, and never a Qronos one;
          //  - every other model (a Qronos model, or a third-party BYOK) gets
          //    the Qronos banner, and never a free-pi one.
          // An empty free-pi answer clears the slot instead of falling back,
          // because a Qronos ad under a free-pi model is the wrong ad.
          if (isFreepiModel(ctx)) {
            await freepiBanner!.render(ctx, context.prompt);
            return;
          }
          await banner.render(deps, ctx, config, context);
        } finally {
          bannerInFlight = false;
          lastBannerAt = Date.now();
        }
      };

      qronos.on("session_start", async (_event, ctx) => {
        stopped = false;
        inline.reset(ctx);

        await Promise.all([renderBanner(ctx, true), renderMeter(deps, ctx)]);

        if (bannerInterval) clearInterval(bannerInterval);
        bannerInterval = setInterval(() => {
          void renderBanner(ctx);
        }, BANNER_REFRESH_MS);
        (bannerInterval as unknown as { unref?: () => void }).unref?.();
      });

      qronos.on("turn_end", async (event: any, ctx) => {
        // Extract prompt from session history if available without adding new hook registrations
        let prompt = "";
        try {
          const entries = ctx.sessionManager.getBranch();
          if (Array.isArray(entries)) {
            for (let i = entries.length - 1; i >= 0; i--) {
              const entry = entries[i];
              if (!entry) continue;
              // Session entries are a union; only "message" ones carry a message body.
              const msg = (entry.type === "message" ? entry.message : entry) as {
                role?: string;
                content?: unknown;
              };
              if (msg?.role === "user") {
                const c = msg.content;
                if (typeof c === "string") { prompt = c; break; }
                if (Array.isArray(c)) {
                  const part = c.find((p: { type?: string }) => p.type === "text") as { text?: string } | undefined;
                  if (part?.text) { prompt = part.text; break; }
                }
              }
            }
          }
        } catch {}

        // The real turns go to the ad network; Gravity prices conversation, not
        // a topic string. The same branch gives the free-pi ad its one line.
        let messages: AdMessage[] = [];
        try {
          messages = messagesFromBranch(ctx.sessionManager.getBranch());
        } catch {}

        // Not awaited: a slow /ads/next (Gravity can take seconds) must not
        // hold up the agent's next step.
        void renderBanner(ctx, false, { prompt, messages });
        // The inline card is money too, so it follows the same rule as the
        // banner: under a free-pi model no Qronos inline card may appear, and a
        // card already on screen is removed as soon as the model changes.
        if (isFreepiModel(ctx)) {
          inline.clear(ctx);
          await renderMeter(deps, ctx);
          return;
        }
        await Promise.all([inline.onTurnEnd(deps, ctx, config, { prompt, messages }), renderMeter(deps, ctx)]);
      });

      qronos.on("session_shutdown", () => {
        stopped = true;
        if (bannerInterval) {
          clearInterval(bannerInterval);
          bannerInterval = undefined;
        }
      });
    },
  };
}
