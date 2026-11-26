import { afterEach, describe, expect, spyOn, test } from "bun:test";

import { fetchAdNext } from "./api";

/**
 * The ad slot is silent on purpose, and that silence is also the problem: "no
 * fill in your country", "the key is sandbox" and "the feature is broken" all
 * look the same. `QRONOS_DEBUG_ADS=1` turns the silence into one line.
 */

const deps = (fetchImpl: typeof fetch) => ({
  baseUrl: "https://api.qronos.me",
  getToken: () => "qr_test",
  sessionId: "s1",
  fetchImpl,
});

function fake(status: number, body = "") {
  return (async () => new Response(body, { status })) as unknown as typeof fetch;
}

const spies: Array<{ mockRestore: () => void }> = [];

function captureError() {
  const spy = spyOn(console, "error").mockImplementation(() => undefined);
  spies.push(spy);
  return spy;
}

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  delete process.env.QRONOS_DEBUG_ADS;
});

describe("a quiet ad slot stays quiet", () => {
  test("204 prints nothing without the flag", async () => {
    const spy = captureError();
    expect(await fetchAdNext(deps(fake(204)), "banner")).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
  });

  test("a 500 prints nothing without the flag either", async () => {
    const spy = captureError();
    expect(await fetchAdNext(deps(fake(500)), "inline")).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("QRONOS_DEBUG_ADS=1 says why", () => {
  test("204 names the slot and says there is no fill", async () => {
    process.env.QRONOS_DEBUG_ADS = "1";
    const spy = captureError();
    await fetchAdNext(deps(fake(204)), "banner");
    const line = String((spy.mock.calls[0] as unknown[])[0]);
    expect(line).toContain("ad banner -> 204 (no fill)");
    expect(line).toContain("https://api.qronos.me");
  });

  test("another failure keeps its status, so it is not mistaken for no fill", async () => {
    process.env.QRONOS_DEBUG_ADS = "1";
    const spy = captureError();
    await fetchAdNext(deps(fake(500)), "banner");
    const line = String((spy.mock.calls[0] as unknown[])[0]);
    expect(line).toContain("ad banner -> 500");
    expect(line).not.toContain("no fill");
  });

  test("a thrown error is named, and cut short", async () => {
    process.env.QRONOS_DEBUG_ADS = "1";
    const spy = captureError();
    const throwing = (async () => {
      throw new Error("socket hang up ".repeat(20));
    }) as unknown as typeof fetch;
    expect(await fetchAdNext(deps(throwing), "inline")).toBeUndefined();
    const line = String((spy.mock.calls[0] as unknown[])[0]);
    expect(line).toContain("ad inline -> failed (socket hang up");
    expect(line.length).toBeLessThan(260);
  });

  test("the gateway's own reason is printed when it sends one", async () => {
    process.env.QRONOS_DEBUG_ADS = "1";
    const spy = captureError();
    const withReason = (async () =>
      new Response("", { status: 204, headers: { "x-ad-miss": "[ads] no fill slot=banner source=gravity fill=0 key=present" } })) as unknown as typeof fetch;
    await fetchAdNext(deps(withReason), "banner");
    const line = String((spy.mock.calls[0] as unknown[])[0]);
    expect(line).toContain("no fill");
    expect(line).toContain("key=present");
  });

  test("a filled slot says so, so the flag never looks broken", async () => {
    process.env.QRONOS_DEBUG_ADS = "1";
    const spy = captureError();
    const body = JSON.stringify({ ad_id: "a1", click_token: "t1", creative: { headline: "hi" } });
    const ad = await fetchAdNext(deps(fake(200, body)), "banner");
    expect(ad).toBeDefined();
    const line = String((spy.mock.calls[0] as unknown[])[0]);
    expect(line).toContain("ad banner -> 200");
  });
});
