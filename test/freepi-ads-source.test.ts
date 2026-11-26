// The ad source: fetch, then count once, and remember what the server said.
import { describe, expect, test } from "bun:test";
import { adsRequiredText, createFreepiAdSource } from "../src/freepi-ads-source";
import { FreepiTokenPool, makeTokenRecord } from "../src/freepi-tokens";

function pool(tokens: string[] = ["fp_token_one"]) {
  const records = tokens.map((token, i) => ({ ...makeTokenRecord(token, []), id: `t${i + 1}` }));
  return new FreepiTokenPool(records, { now: () => 1_000 });
}

const ad = {
  ad_id: "ad-1",
  click_token: "tok-1",
  headline: "Ship it faster",
  click_url: "https://ads.test/c/1",
};

function sourceWith(responses: Array<() => Response>, extra: { onAdsRequired?: (v: boolean) => void } = {}) {
  const paths: string[] = [];
  let i = 0;
  const fetchImpl = (async (url: string) => {
    paths.push(new URL(url).pathname);
    const next = responses[Math.min(i, responses.length - 1)]!;
    i += 1;
    return next();
  }) as unknown as typeof fetch;
  const source = createFreepiAdSource({
    getPool: async () => pool(),
    identity: { version: "1.0.30", os: "linux", arch: "x64" },
    fetchImpl,
    ...extra,
  });
  return { source, paths };
}

describe("createFreepiAdSource", () => {
  test("fetch → one ads/next call, adsRequired false", async () => {
    const { source, paths } = sourceWith([() => Response.json(ad)]);
    const result = await source.fetch("banner");
    expect(result.ad?.adId).toBe("ad-1");
    expect(result.adsRequired).toBe(false);
    expect(paths).toEqual(["/ads/next"]);
  });

  test("204 → no ad, still no impression", async () => {
    const { source, paths } = sourceWith([() => new Response(null, { status: 204 })]);
    const result = await source.fetch("banner");
    expect(result.ad).toBeUndefined();
    expect(paths).toEqual(["/ads/next"]);
  });

  test("drawn → an impression; the same click token is never counted twice", async () => {
    const { source, paths } = sourceWith([() => Response.json(ad), () => Response.json({ ok: true })]);
    const fetched = await source.fetch("banner");
    await source.drawn(fetched.ad!);
    const again = await source.drawn(fetched.ad!);
    expect(paths).toEqual(["/ads/next", "/ads/impression"]);
    expect(again.skipped).toBe(true);
  });

  test("a new ad is counted again", async () => {
    const { source, paths } = sourceWith([
      () => Response.json(ad),
      () => Response.json({ ok: true }),
      () => Response.json({ ...ad, click_token: "tok-2" }),
      () => Response.json({ ok: true }),
    ]);
    await source.drawn((await source.fetch("banner")).ad!);
    await source.drawn((await source.fetch("banner")).ad!);
    expect(paths.filter((p) => p === "/ads/impression")).toHaveLength(2);
  });

  test("ads_required is remembered and reported once per change", async () => {
    const seen: boolean[] = [];
    const { source } = sourceWith([() => Response.json({ ...ad, ads_required: true })], {
      onAdsRequired: (v) => seen.push(v),
    });
    expect(source.adsRequired()).toBe(false);
    await source.fetch("banner");
    expect(source.adsRequired()).toBe(true);
    expect(seen).toEqual([true]);
    // the same answer again is not a new event
    await source.fetch("banner");
    expect(seen).toEqual([true]);
  });

  test("a throwing listener cannot break the fetch", async () => {
    const { source } = sourceWith([() => Response.json({ ...ad, ads_required: true })], {
      onAdsRequired: () => {
        throw new Error("boom");
      },
    });
    const result = await source.fetch("banner");
    expect(result.ad?.adId).toBe("ad-1");
  });

  test("reset forgets the dedupe, never the ads_required flag", async () => {
    const { source, paths } = sourceWith([
      () => Response.json({ ...ad, ads_required: true }),
      () => Response.json({ ok: true }),
      () => Response.json({ ok: true }),
    ]);
    const fetched = await source.fetch("banner");
    await source.drawn(fetched.ad!);
    source.reset();
    await source.drawn(fetched.ad!);
    expect(paths.filter((p) => p === "/ads/impression")).toHaveLength(2);
    expect(source.adsRequired()).toBe(true);
  });
});

describe("adsRequiredText", () => {
  test("silent when all is well", () => {
    expect(adsRequiredText(false)).toBeUndefined();
  });

  test("one plain sentence when it is not", () => {
    const line = adsRequiredText(true)!;
    expect(line).toContain("ads_required");
    expect(line).toContain("allowance");
  });
});
