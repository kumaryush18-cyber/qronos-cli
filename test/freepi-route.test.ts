import { describe, expect, test } from "bun:test";

import {
  buildRouteEvent,
  postRouteEvent,
  readUsageTokens,
  reportRouteEvent,
  slotFromKey,
  type FreepiRouteEvent,
} from "../src/freepi-route";

const MESSAGE = {
  usage: { input: 412, output: 588, cacheRead: 0, cacheWrite: 0, totalTokens: 1000 },
};

const EVENT: FreepiRouteEvent = {
  key: "srv-2",
  slot: 1,
  model: "particle",
  status: 200,
  ms: 1200,
  inputTokens: 412,
  outputTokens: 588,
};

function fakeFetch(spec: { status?: number; throw?: boolean } = {}) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (spec.throw) throw new Error("network down");
    return new Response("", { status: spec.status ?? 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const on = () => true;

describe("slotFromKey", () => {
  test("a remote id names its slot, counting from zero", () => {
    expect(slotFromKey("srv-1")).toBe(0);
    expect(slotFromKey("srv-3")).toBe(2);
  });

  test("an id that says nothing about a slot is null, never a guess", () => {
    expect(slotFromKey("t1")).toBeNull();
    expect(slotFromKey("srv-0")).toBeNull();
    expect(slotFromKey(undefined)).toBeNull();
    expect(slotFromKey("")).toBeNull();
  });
});

describe("readUsageTokens", () => {
  test("the two counts pi reports", () => {
    expect(readUsageTokens(MESSAGE)).toEqual({ inputTokens: 412, outputTokens: 588 });
  });

  test("a message with no usage is two nulls, never two zeros", () => {
    expect(readUsageTokens(undefined)).toEqual({ inputTokens: null, outputTokens: null });
    expect(readUsageTokens({ role: "assistant" })).toEqual({ inputTokens: null, outputTokens: null });
  });

  test("nonsense counts are refused rather than shown", () => {
    expect(readUsageTokens({ usage: { input: -3, output: Number.NaN } })).toEqual({
      inputTokens: null,
      outputTokens: null,
    });
  });
});

describe("buildRouteEvent", () => {
  test("carries the slot, the model, the status, the duration and the tokens", () => {
    const event = buildRouteEvent({
      key: "srv-2",
      model: "particle",
      status: 200,
      startedAt: 1_000,
      finishedAt: 2_200,
      message: MESSAGE,
    });
    expect(event).toEqual(EVENT);
  });

  test("a request that never reached the service is status 0", () => {
    const event = buildRouteEvent({ key: "srv-1", model: "particle", status: undefined, startedAt: 5, finishedAt: 8 });
    expect(event.status).toBe(0);
    expect(event.ms).toBe(3);
  });

  test("a clock that jumps backwards never shows a negative duration", () => {
    const event = buildRouteEvent({ key: "srv-1", model: "particle", status: 200, startedAt: 2_000, finishedAt: 1_000 });
    expect(event.ms).toBe(0);
  });

  test("the event holds no token and no prompt", () => {
    const text = JSON.stringify(buildRouteEvent({ key: "srv-1", model: "particle", status: 200, startedAt: 0, finishedAt: 1, message: MESSAGE }));
    expect(text).not.toContain("eyJ");
    expect(text).not.toContain("content");
  });
});

describe("postRouteEvent", () => {
  test("posts to the cli route with the user's own key", async () => {
    const { fetchImpl, calls } = fakeFetch();
    const ok = await postRouteEvent(EVENT, {
      fetchImpl,
      origin: "https://api.qronos.me",
      authToken: async () => "qr_test",
      enabled: on,
    });
    expect(ok).toBe(true);
    expect(calls[0]!.url).toBe("https://api.qronos.me/api/cli/freepi/routing");
    expect((calls[0]!.init?.headers as Record<string, string>).authorization).toBe("Bearer qr_test");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual(EVENT);
  });

  test("no signed-in key means no report, silently", async () => {
    const { fetchImpl, calls } = fakeFetch();
    const ok = await postRouteEvent(EVENT, { fetchImpl, authToken: async () => undefined, enabled: on });
    expect(ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test("a telemetry opt-out sends nothing", async () => {
    const { fetchImpl, calls } = fakeFetch();
    const ok = await postRouteEvent(EVENT, { fetchImpl, authToken: async () => "k", enabled: () => false });
    expect(ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test("a network failure is a false, never a thrown error", async () => {
    const { fetchImpl } = fakeFetch({ throw: true });
    const ok = await postRouteEvent(EVENT, { fetchImpl, authToken: async () => "k", enabled: on });
    expect(ok).toBe(false);
  });

  test("a refused report is a false too", async () => {
    const { fetchImpl } = fakeFetch({ status: 500 });
    expect(await postRouteEvent(EVENT, { fetchImpl, authToken: async () => "k", enabled: on })).toBe(false);
  });
});

describe("reportRouteEvent is fire and forget", () => {
  test("it returns at once and a failure stays silent", () => {
    const { fetchImpl, calls } = fakeFetch({ throw: true });
    expect(() => reportRouteEvent(EVENT, { fetchImpl, authToken: async () => "k", enabled: on })).not.toThrow();
    expect(calls.length).toBeLessThanOrEqual(1);
  });
});
