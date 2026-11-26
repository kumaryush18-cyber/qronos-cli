import { describe, expect, test } from "bun:test";
import { postRemoteFreepiToken } from "../src/freepi-remote";
import {
  FREEPI_REMOTE_MAX_TOKENS,
  FREEPI_REMOTE_PATH,
  fetchRemoteFreepiTokens,
  readTokenList,
  remoteRecords,
} from "../src/freepi-remote";

const TOKEN_A = "eyJhbGciOiJIUzI1NiJ9.pool-token-a.signature";
const TOKEN_B = "eyJhbGciOiJIUzI1NiJ9.pool-token-b.signature";

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

const base = "https://api.qronos.me";

describe("fetchRemoteFreepiTokens", () => {
  test("no key means no request at all", async () => {
    let called = 0;
    const result = await fetchRemoteFreepiTokens({
      baseUrl: base,
      jwt: null,
      fetchImpl: (async () => {
        called += 1;
        return jsonResponse(200, { tokens: [] });
      }) as unknown as typeof fetch,
    });
    expect(result).toMatchObject({ ok: false, reason: "no-key" });
    expect(called).toBe(0);
  });

  test("a good reply gives the tokens", async () => {
    const result = await fetchRemoteFreepiTokens({
      baseUrl: base,
      jwt: "key",
      fetchImpl: (async () =>
        jsonResponse(200, { tokens: [{ id: "0", label: "main", token: TOKEN_A }] })) as unknown as typeof fetch,
    });
    expect(result).toEqual({ ok: true, tokens: [TOKEN_A] });
  });

  test("the request goes to the documented path with a Bearer key", async () => {
    let seen: { url: string; auth: string } | undefined;
    await fetchRemoteFreepiTokens({
      baseUrl: "https://api.qronos.me/",
      jwt: "the-key",
      fetchImpl: (async (url: string, init: { headers: Record<string, string> }) => {
        seen = { url, auth: init.headers.Authorization };
        return jsonResponse(200, { tokens: [{ token: TOKEN_A }] });
      }) as unknown as typeof fetch,
    });
    expect(seen?.url).toBe(`https://api.qronos.me${FREEPI_REMOTE_PATH}`);
    expect(seen?.auth).toBe("Bearer the-key");
  });

  test("a refused key says so", async () => {
    const result = await fetchRemoteFreepiTokens({
      baseUrl: base,
      jwt: "bad",
      fetchImpl: (async () => jsonResponse(401, { error: "Unauthorized" })) as unknown as typeof fetch,
    });
    expect(result).toMatchObject({ ok: false, reason: "unauthorized" });
  });

  test("an empty pool passes the server's own sentence through", async () => {
    const sentence = "No free-pi token is available right now.";
    const result = await fetchRemoteFreepiTokens({
      baseUrl: base,
      jwt: "key",
      fetchImpl: (async () => jsonResponse(503, { error: sentence })) as unknown as typeof fetch,
    });
    expect(result).toEqual({ ok: false, reason: "empty", message: sentence });
  });

  test("a 503 with a broken body still has a sentence", async () => {
    const result = await fetchRemoteFreepiTokens({
      baseUrl: base,
      jwt: "key",
      fetchImpl: (async () =>
        ({
          ok: false,
          status: 503,
          json: async () => {
            throw new Error("not json");
          },
        }) as unknown as Response) as unknown as typeof fetch,
    });
    expect(result).toMatchObject({ ok: false, reason: "empty" });
    if (!result.ok) expect(result.message.length).toBeGreaterThan(10);
  });

  test("an unreachable server never throws", async () => {
    const result = await fetchRemoteFreepiTokens({
      baseUrl: base,
      jwt: "key",
      fetchImpl: (async () => {
        throw new Error("getaddrinfo ENOTFOUND");
      }) as unknown as typeof fetch,
    });
    expect(result).toMatchObject({ ok: false, reason: "unreachable" });
    if (!result.ok) expect(result.message).not.toContain("getaddrinfo");
  });

  test("another status is a plain sentence with the code", async () => {
    const result = await fetchRemoteFreepiTokens({
      baseUrl: base,
      jwt: "key",
      fetchImpl: (async () => jsonResponse(500, {})) as unknown as typeof fetch,
    });
    expect(result).toMatchObject({ ok: false, reason: "unreachable" });
  });
});

describe("readTokenList", () => {
  test("a clean list is read and de-duplicated", () => {
    expect(readTokenList({ tokens: [{ token: TOKEN_A }, { token: TOKEN_A }, { token: TOKEN_B }] })).toEqual([
      TOKEN_A,
      TOKEN_B,
    ]);
  });

  test("anything odd drops the whole reply, never half of it", () => {
    expect(readTokenList(undefined)).toBeUndefined();
    expect(readTokenList({})).toBeUndefined();
    expect(readTokenList({ tokens: "nope" })).toBeUndefined();
    expect(readTokenList({ tokens: [null] })).toBeUndefined();
    expect(readTokenList({ tokens: [{ token: 42 }] })).toBeUndefined();
    expect(readTokenList({ tokens: [{ token: "too-short" }] })).toBeUndefined();
    expect(readTokenList({ tokens: [{ token: `${TOKEN_A} extra` }] })).toBeUndefined();
  });

  test("the list is capped, so a broken server cannot flood the pool", () => {
    const many = Array.from({ length: 40 }, (_, index) => ({
      token: `eyJhbGciOiJIUzI1NiJ9.token-number-${index}.signature`,
    }));
    expect(readTokenList({ tokens: many })).toHaveLength(FREEPI_REMOTE_MAX_TOKENS);
  });
});

describe("remoteRecords", () => {
  test("ids cannot collide with a saved file, and the label says where it came from", () => {
    const records = remoteRecords([TOKEN_A, TOKEN_B]);
    expect(records.map((record) => record.id)).toEqual(["srv-1", "srv-2"]);
    expect(records.map((record) => record.label)).toEqual(["server", "server"]);
    expect(records.every((record) => record.token.startsWith("eyJ"))).toBe(true);
  });

  test("each record gets its own session id, as free-pi requires", () => {
    const records = remoteRecords([TOKEN_A, TOKEN_B]);
    expect(records[0]!.sessionId).not.toBe(records[1]!.sessionId);
  });
});

// ---------------------------------------------------------------------------
// POST: a login fills the shared pool
// ---------------------------------------------------------------------------

const SAVE_TOKEN = "eyJ-a-real-length-token-value-123456";

function saveFetch(status: number, body: unknown) {
  const seen: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    seen.push({ url, init });
    return Response.json(body, { status });
  }) as unknown as typeof fetch;
  return { seen, fetchImpl };
}

describe("postRemoteFreepiToken", () => {
  test("posts the token and answers the slot and fingerprint", async () => {
    const { seen, fetchImpl } = saveFetch(200, { slot: 2, fingerprint: "e2632c", duplicate: false });
    const result = await postRemoteFreepiToken(SAVE_TOKEN, { baseUrl: "https://api.qronos.me", jwt: "qr_key", fetchImpl });
    expect(result).toEqual({ ok: true, slot: 2, fingerprint: "e2632c", duplicate: false });
    expect(seen[0]!.url).toBe("https://api.qronos.me/api/cli/freepi/tokens");
    expect(seen[0]!.init?.method).toBe("POST");
    expect(String(seen[0]!.init?.body)).toContain(SAVE_TOKEN);
    expect((seen[0]!.init?.headers as Record<string, string>).Authorization).toBe("Bearer qr_key");
  });

  test("a duplicate is not an error", async () => {
    const { fetchImpl } = saveFetch(200, { slot: 0, fingerprint: "abcd12", duplicate: true });
    const result = await postRemoteFreepiToken(SAVE_TOKEN, { baseUrl: "https://x", jwt: "k", fetchImpl });
    expect(result).toMatchObject({ ok: true, slot: 0, duplicate: true });
  });

  test("no key means no upload at all", async () => {
    let called = 0;
    const fetchImpl = (async () => {
      called += 1;
      return Response.json({});
    }) as unknown as typeof fetch;
    const result = await postRemoteFreepiToken(SAVE_TOKEN, { baseUrl: "https://x", jwt: null, fetchImpl });
    expect(result).toMatchObject({ ok: false, reason: "no-key" });
    expect(called).toBe(0);
  });

  test("a full pool is a plain sentence, not a crash", async () => {
    const { fetchImpl } = saveFetch(409, { error: "The free-pi token pool is full." });
    const result = await postRemoteFreepiToken(SAVE_TOKEN, { baseUrl: "https://x", jwt: "k", fetchImpl });
    expect(result).toEqual({ ok: false, reason: "full", message: "The free-pi token pool is full." });
  });

  test("a refused token is invalid, not unreachable", async () => {
    const { fetchImpl } = saveFetch(400, { error: "free-pi refused this token." });
    const result = await postRemoteFreepiToken(SAVE_TOKEN, { baseUrl: "https://x", jwt: "k", fetchImpl });
    expect(result).toMatchObject({ ok: false, reason: "invalid" });
  });

  test("a rejected key is unauthorized", async () => {
    const { fetchImpl } = saveFetch(401, { error: "Unauthorized" });
    const result = await postRemoteFreepiToken(SAVE_TOKEN, { baseUrl: "https://x", jwt: "bad", fetchImpl });
    expect(result).toMatchObject({ ok: false, reason: "unauthorized" });
  });

  test("a network error is unreachable and never throws", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED https://api.qronos.me");
    }) as unknown as typeof fetch;
    const result = await postRemoteFreepiToken(SAVE_TOKEN, { baseUrl: "https://x", jwt: "k", fetchImpl });
    expect(result).toMatchObject({ ok: false, reason: "unreachable" });
    expect(JSON.stringify(result)).not.toContain(SAVE_TOKEN);
  });

  test("a reply without a slot is the wrong shape", async () => {
    const { fetchImpl } = saveFetch(200, { fingerprint: "e2632c" });
    const result = await postRemoteFreepiToken(SAVE_TOKEN, { baseUrl: "https://x", jwt: "k", fetchImpl });
    expect(result).toMatchObject({ ok: false, reason: "bad-shape" });
  });

  test("is never retried, so a retry cannot fill two slots", async () => {
    const { seen, fetchImpl } = saveFetch(200, { slot: 1, fingerprint: "abcdef" });
    await postRemoteFreepiToken(SAVE_TOKEN, { baseUrl: "https://x", jwt: "k", fetchImpl });
    expect(seen).toHaveLength(1);
  });
});
