import { afterEach, describe, expect, test } from "bun:test";
import { envTokenRecord, FREEPI_TOKEN_ENV } from "../src/freepi-env-token";
import { loadFreepiPool, resetFreepiPools } from "../src/freepi-pool-singleton";
import { makeTokenRecord, type FreepiTokenRecord } from "../src/freepi-tokens";

const REAL_LOOKING = "eyJhbGciOiJIUzI1NiJ9.abcdefghijklmnop.qrstuvwxyz012345";

afterEach(() => {
  resetFreepiPools();
  delete process.env[FREEPI_TOKEN_ENV];
});

describe("envTokenRecord", () => {
  test("a long value becomes one token, labelled env", () => {
    const record = envTokenRecord({ [FREEPI_TOKEN_ENV]: REAL_LOOKING });
    expect(record?.token).toBe(REAL_LOOKING);
    expect(record?.label).toBe("env");
    expect(record?.id).toBe("env");
  });

  test("missing, blank and short values are not tokens", () => {
    expect(envTokenRecord({})).toBeUndefined();
    expect(envTokenRecord({ [FREEPI_TOKEN_ENV]: "   " })).toBeUndefined();
    expect(envTokenRecord({ [FREEPI_TOKEN_ENV]: "too-short" })).toBeUndefined();
  });

  test("a value is trimmed, so a copied line works", () => {
    expect(envTokenRecord({ [FREEPI_TOKEN_ENV]: `  ${REAL_LOOKING}\n` })?.token).toBe(REAL_LOOKING);
  });
});

describe("the pool no longer reads the environment", () => {
  const saved: FreepiTokenRecord[] = [makeTokenRecord("saved-token-value-1234567890", [], "main")];

  test("an env token alone is an empty pool, because the pool is the only source", async () => {
    const pool = await loadFreepiPool({
      path: "/nowhere",
      read: async () => ({ version: 1, tokens: [] }),
      env: { [FREEPI_TOKEN_ENV]: REAL_LOOKING },
    });
    expect(pool.size).toBe(0);
  });

  test("a saved file token is ignored too", async () => {
    const pool = await loadFreepiPool({
      path: "/nowhere-2",
      read: async () => ({ version: 1, tokens: saved }),
      env: { [FREEPI_TOKEN_ENV]: REAL_LOOKING },
    });
    expect(pool.size).toBe(0);
  });

  test("the real pool still fills from the server", async () => {
    const pool = await loadFreepiPool({
      remote: async () => [makeTokenRecord(REAL_LOOKING, [], "server")],
    });
    expect(pool.size).toBe(1);
  });

  test("no source at all: an empty pool, never an invented token", async () => {
    const pool = await loadFreepiPool({ path: "/nowhere-4", read: async () => ({ version: 1, tokens: [] }), env: {} });
    expect(pool.size).toBe(0);
  });
});
