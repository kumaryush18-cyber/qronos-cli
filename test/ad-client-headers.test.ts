// The identity headers, on their own: no network, no pool, no terminal.
import { describe, expect, test } from "bun:test";
import {
  AD_CONTEXT_MAX_CHARS,
  adContextFrom,
  adRequestHeaders,
  clientHeaders,
  clientIdentity,
  modelRequestHeaders,
} from "../src/ad-client-headers";

const identity = { version: "1.0.30", os: "linux", arch: "x64" };

describe("clientIdentity", () => {
  test("takes the three facts from the caller", () => {
    expect(clientIdentity({ version: "1.0.30", platform: "win32", arch: "arm64" })).toEqual({
      version: "1.0.30",
      os: "win32",
      arch: "arm64",
    });
  });

  test("falls back to the running process", () => {
    const id = clientIdentity({ version: "9.9.9" });
    expect(id.os).toBe(process.platform);
    expect(id.arch).toBe(process.arch);
  });
});

describe("clientHeaders", () => {
  test("three headers, exactly", () => {
    expect(clientHeaders(identity)).toEqual({
      "x-client-version": "1.0.30",
      "x-client-os": "linux",
      "x-client-arch": "x64",
    });
  });

  test("an unknown value is left out, never sent as the word undefined", () => {
    const headers = clientHeaders({ version: "", os: "linux", arch: "   " });
    expect(headers).toEqual({ "x-client-os": "linux" });
    expect(Object.values(headers)).not.toContain("undefined");
  });
});

describe("adContextFrom", () => {
  test("one line, no colours", () => {
    expect(adContextFrom("why\nis \u001b[31mmy build\u001b[0m slow")).toBe("why is my build slow");
  });

  test("an empty or blank prompt gives nothing", () => {
    expect(adContextFrom("")).toBeUndefined();
    expect(adContextFrom("   \n  ")).toBeUndefined();
    expect(adContextFrom(undefined)).toBeUndefined();
  });

  test("a long prompt is cut to the cap, never longer", () => {
    const line = adContextFrom("x".repeat(5000)) ?? "";
    expect(line.length).toBeLessThanOrEqual(AD_CONTEXT_MAX_CHARS);
  });
});

describe("adRequestHeaders", () => {
  test("identity, session and context together", () => {
    expect(adRequestHeaders({ identity, sessionId: "session-one", adContext: "slow build" })).toEqual({
      "x-client-version": "1.0.30",
      "x-client-os": "linux",
      "x-client-arch": "x64",
      "x-session-id": "session-one",
      "x-ad-context": "slow build",
    });
  });

  test("no session id → no header", () => {
    expect(adRequestHeaders({ identity, sessionId: "  " })).not.toHaveProperty("x-session-id");
  });

  test("no context → no header", () => {
    expect(adRequestHeaders({ identity, sessionId: "s1" })).not.toHaveProperty("x-ad-context");
  });
});

describe("modelRequestHeaders", () => {
  test("identity plus the token's own session id, and no ad context", () => {
    const headers = modelRequestHeaders(identity, "session-one");
    expect(headers["x-session-id"]).toBe("session-one");
    expect(headers["x-client-version"]).toBe("1.0.30");
    expect(headers).not.toHaveProperty("x-ad-context");
  });
});
