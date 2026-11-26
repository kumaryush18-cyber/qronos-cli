// `qronos freepi add | list | remove`: the words the user sees, and the promise
// that no secret is ever printed.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addFreepiToken, readFreepiStore } from "../src/freepi-store";
import { formatTokenRows, runFreepi, FREEPI_USAGE } from "../src/freepi-cmd";
import { resetFreepiAdsState, setFreepiAdsRequired } from "../src/freepi-ads-state";

const made: string[] = [];

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "qronos-freepi-cmd-"));
  made.push(dir);
  return join(dir, "freepi.json");
}

afterEach(() => {
  while (made.length > 0) {
    const dir = made.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function host(path: string, stdin?: string) {
  const out: string[] = [];
  const err: string[] = [];
  return {
    deps: {
      path,
      log: (line: string) => out.push(line),
      error: (line: string) => err.push(line),
      readStdin: async () => stdin ?? "",
    },
    out,
    err,
  };
}

describe("runFreepi", () => {
  test("no action prints the usage", async () => {
    const path = tempFile();
    const { deps, out } = host(path);
    expect(await runFreepi([], deps)).toBe(0);
    expect(out[0]).toBe(FREEPI_USAGE);
  });

  test("add saves a token and says which id it got", async () => {
    const path = tempFile();
    const { deps, out } = host(path);
    expect(await runFreepi(["add", "fp_abcdefghijkl", "main"], deps)).toBe(0);
    expect(out[0]).toContain("Saved t1 (main)");
    expect(out[0]).toContain("fp_a…ijkl");
  });

  test("the full token never appears in any output", async () => {
    const path = tempFile();
    const { deps, out, err } = host(path);
    await runFreepi(["add", "fp_abcdefghijkl", "main"], deps);
    await runFreepi(["list"], deps);
    const all = [...out, ...err].join("\n");
    expect(all).not.toContain("fp_abcdefghijkl");
  });

  test("add with no token is an error, and saves nothing", async () => {
    const path = tempFile();
    const { deps, err } = host(path);
    expect(await runFreepi(["add"], deps)).toBe(2);
    expect(err[0]).toContain("Which token?");
  });

  test("add - reads the token from stdin", async () => {
    const path = tempFile();
    const { deps, out } = host(path, "  fp_from_pipe_1234  \n");
    expect(await runFreepi(["add", "-", "piped"], deps)).toBe(0);
    expect(out[0]).toContain("piped");
  });

  test("an empty piped token is refused", async () => {
    const path = tempFile();
    const { deps, err } = host(path, "   \n");
    expect(await runFreepi(["add", "-"], deps)).toBe(2);
    expect(err[0]).toContain("empty");
  });

  test("the same token twice says so instead of counting it twice", async () => {
    const path = tempFile();
    await addFreepiToken(path, "fp_same_token_1");
    const { deps, out } = host(path);
    expect(await runFreepi(["add", "fp_same_token_1"], deps)).toBe(0);
    expect(out[0]).toContain("already saved");
  });

  test("list on an empty pool says the free models are unavailable", async () => {
    const path = tempFile();
    const { deps, out } = host(path);
    await runFreepi(["list"], deps);
    expect(out[0]).toContain("shared pool is empty");
    expect(out[0]).not.toContain("free-pi");
  });

  test("list shows one row per token and the one-at-a-time rule", async () => {
    const path = tempFile();
    await addFreepiToken(path, "fp_first_token_1", "main");
    await addFreepiToken(path, "fp_second_token_2", "spare");
    const { deps, out } = host(path);
    await runFreepi(["list"], deps);
    expect(out[0]).toContain("2 tokens");
    expect(out[1]).toContain("main");
    expect(out[2]).toContain("spare");
  });

  test("remove by label removes that token", async () => {
    const path = tempFile();
    await addFreepiToken(path, "fp_first_token_1", "main");
    const { deps, out } = host(path);
    expect(await runFreepi(["remove", "main"], deps)).toBe(0);
    expect(out[0]).toContain("Removed t1 (main)");
  });

  test("remove with an unknown word lists the known names", async () => {
    const path = tempFile();
    await addFreepiToken(path, "fp_first_token_1", "main");
    const { deps, err } = host(path);
    expect(await runFreepi(["remove", "nope"], deps)).toBe(2);
    expect(err[0]).toContain("main");
  });

  test("remove with no word is an error", async () => {
    const path = tempFile();
    const { deps, err } = host(path);
    expect(await runFreepi(["remove"], deps)).toBe(2);
    expect(err[0]).toContain("Which one?");
  });

  test("an unknown action prints the usage", async () => {
    const path = tempFile();
    const { deps, err } = host(path);
    expect(await runFreepi(["dance"], deps)).toBe(2);
    expect(err[0]).toContain("Unknown action");
  });
});

describe("formatTokenRows", () => {
  test("a cooling token says how long is left", () => {
    const rows = formatTokenRows(
      [{ id: "t1", token: "fp_abcdefghijkl", sessionId: "s", coolDownUntil: 65_000, failures: 1 }],
      5_000,
    );
    expect(rows[1]).toContain("cooling down 60s");
  });
});

describe("list shows the ads_required warning", () => {
  afterEach(() => resetFreepiAdsState());

  test("silent while the server is happy", async () => {
    resetFreepiAdsState();
    const path = tempFile();
    await addFreepiToken(path, "fp_real_token_1234", "main");
    const h = host(path);
    expect(await runFreepi(["list"], h.deps)).toBe(0);
    expect(h.out.join("\n")).not.toContain("ads_required");
  });

  test("one sentence when the server says impressions do not count", async () => {
    setFreepiAdsRequired(true);
    const path = tempFile();
    await addFreepiToken(path, "fp_real_token_1234", "main");
    const h = host(path);
    expect(await runFreepi(["list"], h.deps)).toBe(0);
    expect(h.out.join("\n")).toContain("ads_required");
    resetFreepiAdsState();
  });
});

describe("qronos freepi status", () => {
  test("tokens, ads and the catalogue in one screen", async () => {
    const path = tempFile();
    await addFreepiToken(path, "fp_real_token_1234", "main");
    const h = host(path);
    const code = await runFreepi(["status"], {
      ...h.deps,
      loadCatalog: async () => ({
        models: [],
        source: "network",
        fetchedAt: Date.now(),
      }),
    });
    const text = h.out.join("\n");
    expect(code).toBe(0);
    expect(text).toContain("1 token");
    expect(text).toContain("fp_r…1234");
    expect(text.toLowerCase()).not.toContain("free-pi");
  });

  test("no catalogue reader is fine: it says so instead of failing", async () => {
    const path = tempFile();
    const h = host(path);
    expect(await runFreepi(["status"], h.deps)).toBe(0);
    expect(h.out.join("\n")).toContain("4 free models");
  });

  test("help lists status", async () => {
    const h = host(tempFile());
    await runFreepi(["help"], h.deps);
    expect(h.out.join("\n")).toContain("freepi status");
  });
});

describe("qronos freepi login", () => {
  test("a finished sign-in saves the token once and prints only a mask", async () => {
    const path = tempFile();
    const h = host(path);
    let polls = 0;
    const fetchImpl = (async (url: string) => {
      const route = new URL(url).pathname;
      if (route === "/auth/github/device") {
        return Response.json({
          session_id: "11111111-1111-4111-8111-111111111111",
          user_code: "ABCD-1234",
          verification_uri: "https://github.com/login/device",
          interval: 2,
        });
      }
      polls += 1;
      return Response.json(polls === 1 ? { status: "pending" } : { token: "fp_logged_in_token_9999" });
    }) as unknown as typeof fetch;
    const opened: string[] = [];
    const code = await runFreepi(["login", "work"], {
      ...h.deps,
      openBrowser: (url) => opened.push(url),
      confirm: async () => false,
      fetchImpl,
      sleep: async () => {},
      inviteUrl: "https://freepi.ai/?ref=gghg7ytd",
      attribution: { signupSrc: "qronos-cli", referralCode: "gghg7ytd" },
    });
    const text = h.out.join("\n");
    expect(code).toBe(0);
    expect(opened[0]).toContain("github.com/login/device");
    expect(text).toContain("https://freepi.ai/?ref=gghg7ytd");
    expect(text).toContain("Signed in");
    expect(text).toContain("fp_l…9999");
    expect(text).not.toContain("fp_logged_in_token_9999");
    const saved = await readFreepiStore(path);
    expect(saved.tokens).toHaveLength(1);
    expect(saved.tokens[0]!.label).toBe("work");
  });

  test("a failed sign-in saves nothing and exits non-zero", async () => {
    const path = tempFile();
    const h = host(path);
    const code = await runFreepi(["login"], {
      ...h.deps,
      fetchImpl: (async () => new Response("no", { status: 500 })) as unknown as typeof fetch,
      sleep: async () => {},
    });
    expect(code).toBe(1);
    expect(h.err.join("\n")).toContain("500");
    expect(await readFreepiStore(path)).toEqual({ version: 1, tokens: [] });
  });

  test("help is not a place that advertises the owner sign-in", async () => {
    const h = host(tempFile());
    await runFreepi(["help"], h.deps);
    expect(h.out.join("\n")).not.toContain("freepi login");
  });
});

describe("list with a token kept in the environment", () => {
  test("says where it came from, never as a saved token", async () => {
    const path = tempFile();
    const { deps, out } = host(path);
    const code = await runFreepi(["list"], {
      ...deps,
      env: { QRONOS_FREEPI_TOKEN: "eyJhbGciOiJIUzI1NiJ9.abcdefghijklmnop.qrstuvwxyz012345" },
    });
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("QRONOS_FREEPI_TOKEN");
    expect(out.join("\n")).toContain("not saved to disk");
    expect(out.join("\n")).not.toContain("qronos freepi add");
  });

  test("a saved token wins, so the list shows the file rows only", async () => {
    const path = tempFile();
    await addFreepiToken(path, "fp_saved_token_1", "main");
    const { deps, out } = host(path);
    await runFreepi(["list"], {
      ...deps,
      env: { QRONOS_FREEPI_TOKEN: "eyJhbGciOiJIUzI1NiJ9.abcdefghijklmnop.qrstuvwxyz012345" },
    });
    expect(out.join("\n")).toContain("main");
    expect(out.join("\n")).not.toContain("QRONOS_FREEPI_TOKEN");
  });
});

// ---------------------------------------------------------------------------
// After a login: the token also goes into the shared pool
// ---------------------------------------------------------------------------

function loginHost(path: string) {
  const h = host(path);
  const uploads: Array<{ token: string; jwt?: string | null; baseUrl: string }> = [];
  const fetchImpl = (async (url: string) => {
    const route = new URL(url).pathname;
    if (route === "/auth/github/device") {
      return Response.json({
        session_id: "11111111-1111-4111-8111-111111111111",
        user_code: "ABCD-1234",
        verification_uri: "https://github.com/login/device",
        interval: 2,
      });
    }
    return Response.json({ token: "eyJ_logged_in_token_value_9999" });
  }) as unknown as typeof fetch;
  return { h, uploads, fetchImpl };
}

const loginDeps = (h: ReturnType<typeof host>, fetchImpl: typeof fetch) => ({
  ...h.deps,
  openBrowser: () => {},
  confirm: async () => false,
  fetchImpl,
  sleep: async () => {},
  inviteUrl: "https://freepi.ai/?ref=gghg7ytd",
  attribution: { signupSrc: "qronos-cli", referralCode: "gghg7ytd" },
});

describe("a login fills the shared pool", () => {
  test("a saved slot prints one line with the slot and six characters", async () => {
    const path = tempFile();
    const { h, uploads, fetchImpl } = loginHost(path);
    const code = await runFreepi(["login"], {
      ...loginDeps(h, fetchImpl),
      jwt: "qr_live_key",
      saveRemote: (async (token: string, options: { baseUrl: string; jwt?: string | null }) => {
        uploads.push({ token, baseUrl: options.baseUrl, jwt: options.jwt });
        return { ok: true as const, slot: 2, fingerprint: "e2632c", duplicate: false };
      }) as never,
    });
    const text = h.out.join("\n");
    expect(code).toBe(0);
    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.baseUrl).toContain("api.qronos.me");
    expect(uploads[0]!.jwt).toBe("qr_live_key");
    expect(text).toContain("Saved to the shared pool · slot 3 · •••e2632c");
    expect(text).not.toContain("eyJ_logged_in_token_value_9999");
  });

  test("the same token twice says it is already there", async () => {
    const path = tempFile();
    const { h, fetchImpl } = loginHost(path);
    const code = await runFreepi(["login"], {
      ...loginDeps(h, fetchImpl),
      jwt: "qr_live_key",
      saveRemote: (async () => ({ ok: true as const, slot: 0, fingerprint: "e2632c", duplicate: true })) as never,
    });
    expect(code).toBe(0);
    expect(h.out.join("\n")).toContain("Already in the shared pool · slot 1 · •••e2632c");
  });

  test("a failed upload never fails the login", async () => {
    const path = tempFile();
    const { h, fetchImpl } = loginHost(path);
    const code = await runFreepi(["login"], {
      ...loginDeps(h, fetchImpl),
      jwt: "qr_live_key",
      saveRemote: (async () => ({
        ok: false as const,
        reason: "unreachable" as const,
        message: "Could not reach Qronos to share the token.",
      })) as never,
    });
    const text = h.out.join("\n");
    expect(code).toBe(0);
    expect(text).toContain("Not in the shared pool yet. Could not reach Qronos to share the token.");
    expect(text).not.toContain("eyJ_logged_in_token_value_9999");
  });

  test("no qronos key means it says so, and the login still succeeds", async () => {
    const path = tempFile();
    const { h, fetchImpl } = loginHost(path);
    const code = await runFreepi(["login"], {
      ...loginDeps(h, fetchImpl),
      jwt: null,
      saveRemote: (async () => ({
        ok: false as const,
        reason: "no-key" as const,
        message: "Not signed in to Qronos, so the token was not shared.",
      })) as never,
    });
    expect(code).toBe(0);
    expect(h.out.join("\n")).toContain("Not in the shared pool yet. Not signed in to Qronos");
  });
});

describe("list and status read the shared pool", () => {
  const records = [
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

  test("list shows the pool rows and says where they came from", async () => {
    const path = tempFile();
    const { deps, out } = host(path);
    const code = await runFreepi(["list"], { ...deps, loadPool: async () => records as never });
    const text = out.join("\n");
    expect(code).toBe(0);
    expect(text).toContain("1 token · one request at a time each");
    expect(text).toContain("source: shared pool (qronos-ai admin panel)");
    expect(text).not.toContain("eyJ-server-token-value-1234567890");
  });

  test("an empty pool says so instead of showing a stale local file", async () => {
    const path = tempFile();
    await addFreepiToken(path, "eyJ-old-file-token-value-12345", "old");
    const { deps, out } = host(path);
    const code = await runFreepi(["list"], { ...deps, loadPool: async () => [] });
    const text = out.join("\n");
    expect(code).toBe(0);
    expect(text).toContain("The shared pool is empty");
    expect(text).not.toContain("old");
  });

  test("status marks an empty pool plainly", async () => {
    const path = tempFile();
    const { deps, out } = host(path);
    await runFreepi(["status"], { ...deps, loadPool: async () => [] });
    expect(out.join("\n")).toContain("source: shared pool, empty");
  });
});
