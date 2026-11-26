// The banner: the order of drawing and counting is the promise.
import { describe, expect, test } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createFreepiBanner, firePixel, freepiCreative, FREEPI_BANNER_WIDGET_ID } from "../src/freepi-ads-banner";
import type { FreepiAd } from "../src/freepi-ads";
import type { FreepiAdSource } from "../src/freepi-ads-source";

function fakeCtx() {
  const widgets: Array<{ id: string; content: unknown }> = [];
  const ctx = {
    ui: {
      setWidget: (id: string, content: unknown) => widgets.push({ id, content }),
      theme: { fg: (_c: string, t: string) => t, bold: (t: string) => t },
    },
  } as unknown as ExtensionContext;
  return { ctx, widgets };
}

const ad: FreepiAd = {
  adId: "ad-1",
  clickToken: "tok-1",
  line: "Ship it faster",
  clickUrl: "https://ads.test/c/1",
};

function fakeSource(result: { ad?: FreepiAd; adsRequired?: boolean }): { source: FreepiAdSource; calls: string[] } {
  const calls: string[] = [];
  const source: FreepiAdSource = {
    async fetch() {
      calls.push("fetch");
      return { ...(result.ad ? { ad: result.ad } : {}), adsRequired: result.adsRequired ?? false, adsRequiredKnown: false };
    },
    async drawn() {
      calls.push("drawn");
      return { ok: true, adsRequired: false };
    },
    adsRequired: () => false,
    reset: () => {},
  };
  return { source, calls };
}

describe("freepiCreative", () => {
  test("a free-pi ad is one headline, nothing invented", () => {
    expect(freepiCreative(ad)).toEqual({ headline: "Ship it faster", body: "", cta: "", accent: "" });
  });
});

describe("createFreepiBanner", () => {
  test("fetch, draw, then count — in that order", async () => {
    const { ctx, widgets } = fakeCtx();
    const { source, calls } = fakeSource({ ad });
    const banner = createFreepiBanner({ source, adMinColumns: 20 });
    const result = await banner.render(ctx);
    expect(result.drawn).toBe(true);
    expect(calls).toEqual(["fetch", "drawn"]);
    expect(widgets).toHaveLength(1);
    expect(widgets[0]!.id).toBe(FREEPI_BANNER_WIDGET_ID);
  });

  test("no ad → the slot is cleared and nothing is counted", async () => {
    const { ctx, widgets } = fakeCtx();
    const { source, calls } = fakeSource({});
    const shown: Array<string | undefined> = [];
    const banner = createFreepiBanner({ source, adMinColumns: 20, onBannerAd: (u) => shown.push(u) });
    const result = await banner.render(ctx);
    expect(result.drawn).toBe(false);
    expect(calls).toEqual(["fetch"]);
    expect(shown).toEqual([undefined]);
    // one widget write: undefined clears the slot
    expect(widgets).toHaveLength(1);
  });

  test("a shut-down session is not drawn into and not counted", async () => {
    const { ctx, widgets } = fakeCtx();
    const { source, calls } = fakeSource({ ad });
    const banner = createFreepiBanner({ source, adMinColumns: 20, isActive: () => false });
    const result = await banner.render(ctx);
    expect(result.drawn).toBe(false);
    expect(widgets).toHaveLength(0);
    expect(calls).toEqual(["fetch"]);
  });

  test("the click URL is mirrored out for /support", async () => {
    const { ctx } = fakeCtx();
    const { source } = fakeSource({ ad });
    const shown: Array<string | undefined> = [];
    const banner = createFreepiBanner({ source, adMinColumns: 20, onBannerAd: (u) => shown.push(u) });
    await banner.render(ctx);
    expect(shown).toEqual(["https://ads.test/c/1"]);
  });

  test("clear() empties the slot and the mirror", () => {
    const { ctx, widgets } = fakeCtx();
    const { source } = fakeSource({ ad });
    const shown: Array<string | undefined> = [];
    const banner = createFreepiBanner({ source, adMinColumns: 20, onBannerAd: (u) => shown.push(u) });
    banner.clear(ctx);
    expect(widgets.at(-1)?.content).toBeUndefined();
    expect(shown).toEqual([undefined]);
  });
});

describe("firePixel", () => {
  test("a real pixel is fetched once", () => {
    const urls: string[] = [];
    const fired = firePixel({ ...ad, impUrl: "https://ads.test/p.gif" }, (async (url: string) => {
      urls.push(url);
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch);
    expect(fired).toBe(true);
    expect(urls).toEqual(["https://ads.test/p.gif"]);
  });

  test("no pixel, or a non-http pixel, is never fired", () => {
    let called = false;
    const fake = (async () => {
      called = true;
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    expect(firePixel(ad, fake)).toBe(false);
    expect(firePixel({ ...ad, impUrl: "javascript:alert(1)" }, fake)).toBe(false);
    expect(called).toBe(false);
  });
});
