// U3: proves the KTD7 handoff — createBannerRenderer's onBannerAd option
// mirrors the currently-shown banner's click URL out to qronos-cli's
// /support command, and clears it (undefined) whenever no ad is shown.
import { describe, expect, test } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "@qronos/shared";
import { createBannerRenderer } from "./banner";
import type { AdsDeps } from "./api";

function fakeCtx(): ExtensionContext {
  const ui = {
    setWidget: () => {},
    theme: { fg: (_c: string, t: string) => t, bold: (t: string) => t },
  };
  return { ui } as unknown as ExtensionContext;
}

function adResponse(clickUrl: string) {
  return Response.json({
    ad_id: "ad-1",
    click_token: `tok-${Math.random()}`,
    creative: { headline: "Try it", body: "The best", cta: "Learn more", accent: "#ff00ff" },
    click_url: clickUrl,
  });
}

const deps: AdsDeps = { baseUrl: "https://api.test", getToken: () => "jwt", sessionId: "s1" };
const config = loadConfig({});

describe("createBannerRenderer onBannerAd (KTD7)", () => {
  test("successful fetch → onBannerAd called with the ad's click_url", async () => {
    const calls: Array<string | undefined> = [];
    const fetchImpl = (async () => adResponse("https://api.qronos.me/c/tok-1")) as unknown as typeof fetch;
    const banner = createBannerRenderer({ onBannerAd: (u) => calls.push(u) });
    await banner.render({ ...deps, fetchImpl }, fakeCtx(), config);
    expect(calls).toEqual(["https://api.qronos.me/c/tok-1"]);
  });

  test("204 (no ad) → onBannerAd called with undefined", async () => {
    const calls: Array<string | undefined> = [];
    const fetchImpl = (async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
    const banner = createBannerRenderer({ onBannerAd: (u) => calls.push(u) });
    await banner.render({ ...deps, fetchImpl }, fakeCtx(), config);
    expect(calls).toEqual([undefined]);
  });

  test("success then a refresh returning 204 → holder ends undefined (stale-link case)", async () => {
    let holder: string | undefined = "unset";
    let status: 200 | 204 = 200;
    const fetchImpl = (async () =>
      status === 200 ? adResponse("https://api.qronos.me/c/tok-2") : new Response(null, { status: 204 })) as unknown as typeof fetch;
    const banner = createBannerRenderer({ onBannerAd: (u) => (holder = u) });

    await banner.render({ ...deps, fetchImpl }, fakeCtx(), config);
    expect(holder).toBe("https://api.qronos.me/c/tok-2");

    status = 204;
    await banner.render({ ...deps, fetchImpl }, fakeCtx(), config);
    expect(holder).toBeUndefined();
  });

  test("onBannerAd not passed → render still works (option is optional)", async () => {
    const fetchImpl = (async () => adResponse("https://api.qronos.me/c/tok-3")) as unknown as typeof fetch;
    const banner = createBannerRenderer();
    await expect(banner.render({ ...deps, fetchImpl }, fakeCtx(), config)).resolves.toBeUndefined();
  });
});

// Regression: a session that is replaced/reloaded mid-fetch leaves an in-flight
// render holding a stale ExtensionContext. pi's runner throws
// "This extension ctx is stale after session replacement or reload." on any
// later ctx.ui use, and because the banner render is fire-and-forget that throw
// escaped into the agent loop and failed the turn (seen via Fusion's
// session-replacement test). Ad writes must be dropped, never fatal.
describe("stale extension context", () => {
  test("a render into a replaced session resolves without throwing", async () => {
    const stale = {
      ui: {
        setWidget: () => {
          throw new Error("This extension ctx is stale after session replacement or reload.");
        },
        setStatus: () => {
          throw new Error("This extension ctx is stale after session replacement or reload.");
        },
        theme: { fg: (_c: string, t: string) => t, bold: (t: string) => t },
      },
    } as unknown as ExtensionContext;
    const fetchImpl = (async () => adResponse("https://api.qronos.me/c/tok-stale")) as unknown as typeof fetch;
    const banner = createBannerRenderer();
    await banner.render({ ...deps, fetchImpl }, stale, config);
    // and the empty-slot path (204) writes undefined through the same guard
    const noAd = (async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
    await banner.render({ ...deps, fetchImpl: noAd }, stale, config);
  });
});
