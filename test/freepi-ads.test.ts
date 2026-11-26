// free-pi's ad endpoints, tested against fake servers only.
import { describe, expect, test } from "bun:test";
import {
  adLine,
  fetchFreepiAd,
  isHttpUrl,
  normalizeFreepiAd,
  readAdsRequired,
  sendFreepiImpression,
  type FreepiAdsDeps,
} from "../src/freepi-ads";
import { FreepiTokenPool, makeTokenRecord } from "../src/freepi-tokens";

function pool(tokens: string[] = ["fp_token_one"]) {
  const records = tokens.map((token, i) => ({ ...makeTokenRecord(token, []), id: `t${i + 1}` }));
  return new FreepiTokenPool(records, { now: () => 1_000 });
}

function deps(rawFetch: (url: string, init?: RequestInit) => Promise<Response>, p = pool()): FreepiAdsDeps {
  return {
    baseUrl: "https://api.freepi.test",
    identity: { version: "1.0.30", os: "linux", arch: "x64" },
    acquire: async () => p.acquire(),
    release: (lease, status) => p.release(lease.tokenId, { status }),
    fetchImpl: rawFetch as unknown as typeof fetch,
  };
}

const ad = {
  ad_id: "ad-1",
  click_token: "tok-1",
  headline: "Ship it faster",
  click_url: "https://ads.test/c/1",
};

describe("random helpers", () => {
  test("only http(s) may ever reach a browser", () => {
    expect(isHttpUrl("https://a.test/x")).toBe(true);
    expect(isHttpUrl("http://a.test/x")).toBe(true);
    expect(isHttpUrl("javascript:alert(1)")).toBe(false);
    expect(isHttpUrl("file:///etc/passwd")).toBe(false);
    expect(isHttpUrl(undefined)).toBe(false);
  });

  test("a line is one row, no colours, cut short", () => {
    expect(adLine("\u001b[32mBuy\nit now\u001b[0m")).toBe("Buy it now");
    expect(adLine("y".repeat(400)).length).toBeLessThanOrEqual(120);
    expect(adLine("y".repeat(400)).endsWith("…")).toBe(true);
  });
});

describe("normalizeFreepiAd", () => {
  test("a flat ad is read", () => {
    expect(normalizeFreepiAd(ad)).toEqual({
      adId: "ad-1",
      clickToken: "tok-1",
      line: "Ship it faster",
      clickUrl: "https://ads.test/c/1",
    });
  });

  test("a nested ad is read too", () => {
    const nested = { ad: { ad_id: "ad-2", click_token: "tok-2", title: "Nested" } };
    expect(normalizeFreepiAd(nested)?.adId).toBe("ad-2");
  });

  test("a non-http click URL is dropped, the ad still draws", () => {
    const parsed = normalizeFreepiAd({ ...ad, click_url: "javascript:alert(1)" });
    expect(parsed?.clickUrl).toBeUndefined();
    expect(parsed?.adId).toBe("ad-1");
  });

  test("an unknown shape gives no ad instead of a broken frame", () => {
    expect(normalizeFreepiAd({ creative: { headline: "x" } })).toBeUndefined();
    expect(normalizeFreepiAd({ ad_id: "a", headline: "no token" })).toBeUndefined();
    expect(normalizeFreepiAd(null)).toBeUndefined();
    expect(normalizeFreepiAd("nope")).toBeUndefined();
  });
});

describe("readAdsRequired", () => {
  test("top level and nested both count", () => {
    expect(readAdsRequired({ ads_required: true })).toBe(true);
    expect(readAdsRequired({ ad: { ads_required: true } })).toBe(true);
    expect(readAdsRequired({ ads_required: false })).toBe(false);
    expect(readAdsRequired(undefined)).toBe(false);
  });
});

describe("fetchFreepiAd", () => {
  test("204 means no ad, and nothing is drawn", async () => {
    const result = await fetchFreepiAd(deps(async () => new Response(null, { status: 204 })), "banner");
    expect(result.ad).toBeUndefined();
    expect(result.adsRequired).toBe(false);
  });

  test("a real ad is returned with its ids", async () => {
    const result = await fetchFreepiAd(deps(async () => Response.json(ad)), "banner");
    expect(result.ad?.adId).toBe("ad-1");
    expect(result.ad?.line).toBe("Ship it faster");
  });

  test("the token travels as a bearer and the session id is the token's own", async () => {
    const seen: Array<Record<string, string>> = [];
    const fake = async (_url: string, init?: RequestInit) => {
      seen.push(init?.headers as Record<string, string>);
      return Response.json(ad);
    };
    const p = pool(["fp_token_one"]);
    await fetchFreepiAd(deps(fake, p), "inline", "slow build");
    expect(seen[0]?.Authorization).toBe("Bearer fp_token_one");
    expect(seen[0]?.["x-session-id"]).toBe(p.exportRecords()[0]!.sessionId);
    expect(seen[0]?.["x-ad-context"]).toBe("slow build");
    expect(seen[0]?.["x-client-version"]).toBe("1.0.30");
  });

  test("the token is free again after the answer", async () => {
    const p = pool();
    await fetchFreepiAd(deps(async () => Response.json(ad), p), "banner");
    expect(p.busyCount).toBe(0);
  });

  test("429 parks the token: the status is not lost", async () => {
    const p = pool();
    await fetchFreepiAd(deps(async () => new Response("slow down", { status: 429 }), p), "banner");
    expect(p.busyCount).toBe(0);
    expect(p.snapshot()[0]!.coolDownSeconds).toBeGreaterThan(0);
  });

  test("a thrown fetch is an answer, not a crash", async () => {
    const result = await fetchFreepiAd(
      deps(async () => {
        throw new Error("socket closed");
      }),
      "banner",
    );
    expect(result.ad).toBeUndefined();
    expect(result.note).toContain("socket closed");
  });

  test("no token at all: no ad, no request", async () => {
    let called = false;
    const result = await fetchFreepiAd(
      deps(async () => {
        called = true;
        return Response.json(ad);
      }, pool([])),
      "banner",
    );
    expect(called).toBe(false);
    expect(result.ad).toBeUndefined();
    expect(result.note).toBe("no free token");
  });
});

describe("sendFreepiImpression", () => {
  test("not drawn → nothing is sent at all", async () => {
    let called = false;
    const result = await sendFreepiImpression(
      deps(async () => {
        called = true;
        return Response.json({ ok: true });
      }),
      { adId: "ad-1", clickToken: "tok-1" },
      { impFired: false },
    );
    expect(called).toBe(false);
    expect(result).toEqual({ ok: false, adsRequired: false, adsRequiredKnown: false, skipped: true });
  });

  test("drawn → one POST with imp_fired true", async () => {
    const bodies: string[] = [];
    const fake = async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") bodies.push(String(init.body));
      return Response.json({ ok: true });
    };
    const result = await sendFreepiImpression(
      deps(fake),
      { adId: "ad-1", clickToken: "tok-1" },
      { impFired: true },
    );
    expect(result.ok).toBe(true);
    expect(JSON.parse(bodies[0]!)).toEqual({ ad_id: "ad-1", click_token: "tok-1", imp_fired: true });
  });

  test("the server's ads_required answer comes back", async () => {
    const result = await sendFreepiImpression(
      deps(async () => Response.json({ ads_required: true })),
      { adId: "ad-1", clickToken: "tok-1" },
      { impFired: true },
    );
    expect(result.adsRequired).toBe(true);
  });

  test("a failed POST is reported, never thrown", async () => {
    const result = await sendFreepiImpression(
      deps(async () => new Response("no", { status: 500 })),
      { adId: "ad-1", clickToken: "tok-1" },
      { impFired: true },
    );
    expect(result.ok).toBe(false);
  });
});
