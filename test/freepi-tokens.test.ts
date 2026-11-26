// The token pool: one request per token, a queue instead of a second request,
// and a cool-down that moves the next request to a different token.
import { describe, expect, test } from "bun:test";
import {
  FreepiTokenPool,
  isCoolDownStatus,
  makeTokenRecord,
  maskToken,
  nextTokenId,
  type FreepiTokenRecord,
} from "../src/freepi-tokens";

function records(count: number): FreepiTokenRecord[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `t${index + 1}`,
    token: `token-${index + 1}-abcdefgh`,
    sessionId: `session-${index + 1}`,
    coolDownUntil: 0,
    failures: 0,
  }));
}

describe("maskToken", () => {
  test("keeps a hint of the key, never the key", () => {
    const masked = maskToken("fp_live_abcdefghijklmnop");
    expect(masked).toBe("fp_l…mnop");
    expect(masked.startsWith("fp_live")).toBe(false);
  });

  test("a very short value is fully hidden", () => {
    expect(maskToken("short")).toBe("*****");
  });
});

describe("isCoolDownStatus", () => {
  test("429, 402 and 403 park the token", () => {
    expect(isCoolDownStatus(429)).toBe(true);
    expect(isCoolDownStatus(402)).toBe(true);
    expect(isCoolDownStatus(403)).toBe(true);
  });

  test("a bad request or a server error does not blame the token", () => {
    expect(isCoolDownStatus(400)).toBe(false);
    expect(isCoolDownStatus(500)).toBe(false);
    expect(isCoolDownStatus(undefined)).toBe(false);
  });
});

describe("acquire and release", () => {
  test("an empty pool hands out nothing", () => {
    expect(new FreepiTokenPool([]).acquire()).toBeUndefined();
  });

  test("one token is never handed out twice at the same time", () => {
    const pool = new FreepiTokenPool(records(1));
    expect(pool.acquire()?.tokenId).toBe("t1");
    expect(pool.acquire()).toBeUndefined();
  });

  test("a second request goes to a different token", () => {
    const pool = new FreepiTokenPool(records(2));
    expect(pool.acquire()?.tokenId).toBe("t1");
    expect(pool.acquire()?.tokenId).toBe("t2");
    expect(pool.acquire()).toBeUndefined();
  });

  test("release makes that token free again", () => {
    const pool = new FreepiTokenPool(records(1));
    const lease = pool.acquire();
    pool.release(lease!.tokenId, { status: 200 });
    expect(pool.acquire()?.tokenId).toBe("t1");
  });

  test("the turn goes round: t1, t2, then t1 again", () => {
    const pool = new FreepiTokenPool(records(2));
    const first = pool.acquire()!;
    const second = pool.acquire()!;
    pool.release(first.tokenId, { status: 200 });
    pool.release(second.tokenId, { status: 200 });
    expect(pool.acquire()?.tokenId).toBe("t1");
  });

  test("a lease carries the token and its one session id", () => {
    const pool = new FreepiTokenPool(records(1));
    const lease = pool.acquire()!;
    expect(lease.token).toBe("token-1-abcdefgh");
    expect(lease.sessionId).toBe("session-1");
  });
});

describe("waiting", () => {
  test("a waiting request gets the token when it is released", async () => {
    let now = 0;
    const sleeps: number[] = [];
    const pool = new FreepiTokenPool(records(1), {
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
        // The first request finishes while the second one waits.
        if (sleeps.length === 1) pool.release("t1", { status: 200 });
      },
    });
    pool.acquire();
    const lease = await pool.waitForFree(5_000);
    expect(lease?.tokenId).toBe("t1");
  });

  test("waiting gives up at the deadline instead of hanging", async () => {
    let now = 0;
    const pool = new FreepiTokenPool(records(1), {
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });
    pool.acquire();
    expect(await pool.waitForFree(1_000)).toBeUndefined();
    expect(now).toBeGreaterThanOrEqual(1_000);
  });
});

describe("cool-down", () => {
  test("a 429 parks the token and the other one is used", () => {
    const pool = new FreepiTokenPool(records(2), { now: () => 0 });
    const first = pool.acquire()!;
    pool.release(first.tokenId, { status: 429 });
    expect(pool.acquire()?.tokenId).toBe("t2");
  });

  test("a parked token is skipped until the cool-down ends", () => {
    let now = 0;
    const pool = new FreepiTokenPool(records(1), { now: () => now, coolDownMs: 1_000 });
    const lease = pool.acquire()!;
    pool.release(lease.tokenId, { status: 429 });
    expect(pool.acquire()).toBeUndefined();
    now = 1_001;
    expect(pool.acquire()?.tokenId).toBe("t1");
  });

  test("a second failure waits twice as long", () => {
    let now = 0;
    const pool = new FreepiTokenPool(records(1), { now: () => now, coolDownMs: 1_000 });
    pool.release(pool.acquire()!.tokenId, { status: 429 });
    let lease = pool.acquire();
    expect(lease).toBeUndefined();
    now = 1_001;
    lease = pool.acquire()!;
    pool.release(lease.tokenId, { status: 429 });
    now += 1_001;
    expect(pool.acquire()).toBeUndefined();
    now += 1_000;
    expect(pool.acquire()?.tokenId).toBe("t1");
  });

  test("the wait is capped, so a broken token is not parked for ever", () => {
    let now = 0;
    const pool = new FreepiTokenPool(records(1), { now: () => now, coolDownMs: 1_000, maxCoolDownMs: 3_000 });
    for (let i = 0; i < 6; i += 1) {
      const lease = pool.acquire();
      if (!lease) {
        now += 3_001;
        continue;
      }
      pool.release(lease.tokenId, { status: 429 });
    }
    const state = pool.snapshot()[0]!;
    expect(state.coolDownSeconds).toBeLessThanOrEqual(3);
  });

  test("one success clears the failure count", () => {
    const pool = new FreepiTokenPool(records(1), { now: () => 0 });
    pool.release(pool.acquire()!.tokenId, { status: 429 });
    pool.release(pool.acquire()?.tokenId ?? "t1", { status: 200 });
    const exported = pool.exportRecords()[0]!;
    expect(exported.failures).toBe(0);
    expect(exported.coolDownUntil).toBe(0);
  });

  test("a bad request frees the token at once", () => {
    const pool = new FreepiTokenPool(records(1), { now: () => 0 });
    pool.release(pool.acquire()!.tokenId, { status: 400 });
    expect(pool.snapshot()[0]!.coolDownSeconds).toBe(0);
    expect(pool.acquire()?.tokenId).toBe("t1");
  });
});

describe("snapshot", () => {
  test("says which token is busy and which is cooling", () => {
    const pool = new FreepiTokenPool(records(2), { now: () => 0 });
    pool.acquire();
    pool.release("t2", { status: 429 });
    const rows = pool.snapshot();
    expect(rows[0]!.busy).toBe(true);
    expect(rows[1]!.coolDownSeconds).toBeGreaterThan(0);
  });

  test("never shows a full token", () => {
    const pool = new FreepiTokenPool(records(1));
    expect(pool.snapshot()[0]!.masked).not.toContain("abcdefgh");
  });
});

describe("records", () => {
  test("a new id never collides", () => {
    const saved = records(3);
    expect(nextTokenId(saved)).toBe("t4");
  });

  test("a new record keeps one session id and no secret in its id", () => {
    const record = makeTokenRecord("fp_secret_value", []);
    expect(record.id).toBe("t1");
    expect(record.sessionId.length).toBeGreaterThan(10);
    expect(record.label).toBeUndefined();
    expect(record.coolDownUntil).toBe(0);
  });

  test("a label is trimmed, and an empty one is dropped", () => {
    expect(makeTokenRecord("x", [], "  main  ").label).toBe("main");
    expect(makeTokenRecord("x", [], "   ").label).toBeUndefined();
  });
});
