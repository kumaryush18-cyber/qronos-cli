// One pool per process: the ad code and the provider must never both hold the
// same token.
//
// The pool has exactly one source now: the shared pool in the qronos-ai admin
// panel. A saved file and an environment variable are deliberately ignored, so a
// broken shared pool is visible instead of being hidden by a stale local token.
import { describe, expect, test } from "bun:test";
import { freepiPoolSource, loadFreepiPool, resetFreepiPools } from "../src/freepi-pool-singleton";
import type { FreepiStore } from "../src/freepi-store";
import { makeTokenRecord } from "../src/freepi-tokens";

function storeWith(tokens: string[]): FreepiStore {
  const records = tokens.map((token, i) => ({ ...makeTokenRecord(token, []), id: `t${i + 1}` }));
  return { version: 1, tokens: records };
}

const REMOTE = [
  {
    id: "srv-1",
    token: "eyJ-server-token-value-1234567890",
    sessionId: "s1",
    addedAt: "2026-01-01T00:00:00.000Z",
    label: "server",
    coolDownUntil: 0,
    failures: 0,
  },
];

describe("loadFreepiPool", () => {
  test("the same key gives the same pool, asked once", async () => {
    resetFreepiPools();
    let asked = 0;
    const remote = async () => {
      asked += 1;
      return REMOTE as never;
    };
    const first = await loadFreepiPool({ remote });
    const second = await loadFreepiPool({ remote });
    expect(first).toBe(second);
    expect(asked).toBe(1);
    expect(first.size).toBe(1);
  });

  test("two keys give two pools", async () => {
    resetFreepiPools();
    const remote = async () => REMOTE as never;
    const a = await loadFreepiPool({ path: "/tmp/a.json", remote });
    const b = await loadFreepiPool({ path: "/tmp/b.json", remote });
    expect(a).not.toBe(b);
  });

  test("an empty pool registers no provider", async () => {
    resetFreepiPools();
    const pool = await loadFreepiPool({ remote: async () => [] });
    expect(pool.size).toBe(0);
  });

  test("a server that throws is an empty pool, never a crash", async () => {
    resetFreepiPools();
    const pool = await loadFreepiPool({
      remote: async () => {
        throw new Error("gateway down");
      },
    });
    expect(pool.size).toBe(0);
  });

  test("no remote at all is an empty pool", async () => {
    resetFreepiPools();
    const pool = await loadFreepiPool({});
    expect(pool.size).toBe(0);
    expect(freepiPoolSource()).toBe("none");
  });

  test("reset forgets the cached pool", async () => {
    resetFreepiPools();
    const remote = async () => REMOTE as never;
    const first = await loadFreepiPool({ path: "/tmp/reset.json", remote });
    resetFreepiPools();
    const second = await loadFreepiPool({ path: "/tmp/reset.json", remote });
    expect(first).not.toBe(second);
  });
});

describe("the shared pool is the only source", () => {
  test("the server fills the pool", async () => {
    resetFreepiPools();
    const pool = await loadFreepiPool({
      read: (async () => ({ version: 1, tokens: [] })) as never,
      env: {},
      remote: async () => REMOTE as never,
    });
    expect(pool.size).toBe(1);
    expect(freepiPoolSource()).toBe("server");
  });

  test("a saved file token is ignored, so a broken pool cannot hide behind it", async () => {
    resetFreepiPools();
    let asked = 0;
    const pool = await loadFreepiPool({
      path: "/tmp/remote-file-ignored.json",
      read: (async () => storeWith(["eyJ-saved-file-token-value-1234"])) as never,
      env: {},
      remote: async () => {
        asked += 1;
        return [];
      },
    });
    expect(pool.size).toBe(0);
    expect(asked).toBe(1);
    expect(freepiPoolSource("/tmp/remote-file-ignored.json")).toBe("none");
  });

  test("an env token is ignored too", async () => {
    resetFreepiPools();
    const pool = await loadFreepiPool({
      env: { QRONOS_FREEPI_TOKEN: "env-token-value-that-is-long-enough" },
      remote: async () => [],
    });
    expect(pool.size).toBe(0);
  });

  test("a server that fails is an empty pool, never a broken start", async () => {
    resetFreepiPools();
    const pool = await loadFreepiPool({
      remote: async () => {
        throw new Error("gateway down");
      },
    });
    expect(pool.size).toBe(0);
  });

  test("the server is asked once per process, not once per caller", async () => {
    resetFreepiPools();
    let asked = 0;
    const options = {
      remote: async () => {
        asked += 1;
        return REMOTE as never;
      },
    };
    await loadFreepiPool(options);
    await loadFreepiPool(options);
    await loadFreepiPool(options);
    expect(asked).toBe(1);
  });
});
