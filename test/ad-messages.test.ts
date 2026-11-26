import { describe, expect, it } from "bun:test";

import {
  AD_HEADER_MAX_CHARS,
  AD_MESSAGE_MAX_CHARS,
  cleanEmailHash,
  encodeMessagesHeader,
  messagesFromBranch,
  textOfContent,
  toAdMessages,
  userAgentFor,
} from "../src/ad-messages";
import { fetchEmailHash, resetEmailHashCache, startEmailHash, attributionEnabled } from "../src/ad-identity";

const HASH = "b".repeat(64);

describe("the conversation we send", () => {
  it("keeps the real user and assistant turns in order", () => {
    const out = toAdMessages([
      { role: "user", content: "why is my build slow" },
      { role: "assistant", content: "the test suite runs twice" },
    ]);
    expect(out.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("reads a pi message with text parts", () => {
    expect(textOfContent([{ type: "text", text: "hello" }, { type: "image" }])).toBe("hello");
  });

  it("unwraps a session branch entry", () => {
    const out = messagesFromBranch([
      { type: "message", message: { role: "user", content: "first" } },
      { type: "other" },
      { type: "message", message: { role: "assistant", content: "second" } },
    ]);
    expect(out).toEqual([
      { role: "user", content: "first" },
      { role: "assistant", content: "second" },
    ]);
  });

  it("drops a system turn, which is not the conversation", () => {
    expect(toAdMessages([{ role: "system", content: "be brief" }])).toEqual([]);
  });

  it("keeps a long paragraph, because the old 500 cap was ours, not Gravity's", () => {
    const paragraph = "p".repeat(1_200);
    const out = toAdMessages([{ role: "user", content: paragraph }]);
    expect(out[0]!.content).toHaveLength(1_200);
  });

  it("cuts only what is absurdly long, and marks it", () => {
    const out = toAdMessages([{ role: "user", content: "x".repeat(AD_MESSAGE_MAX_CHARS + 10) }]);
    expect(out[0]!.content).toHaveLength(AD_MESSAGE_MAX_CHARS);
    expect(out[0]!.content.endsWith("…")).toBe(true);
  });

  it("strips terminal colour codes", () => {
    const out = toAdMessages([{ role: "user", content: "\u001b[32mgreen\u001b[0m answer" }]);
    expect(out[0]!.content).toBe("green answer");
  });

  it("redacts a secret before it leaves the machine", () => {
    const out = toAdMessages([{ role: "user", content: "key sk-abcdefghijklmnopqrstuvwxyz123456" }]);
    expect(out[0]!.content).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");
  });

  it("keeps only the last eight turns", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ role: "user" as const, content: `t${i}` }));
    const out = toAdMessages(many);
    expect(out).toHaveLength(8);
    expect(out[7]!.content).toBe("t11");
  });

  it("travels as one header, and nothing when empty", () => {
    expect(encodeMessagesHeader([])).toBeUndefined();
    const encoded = encodeMessagesHeader([{ role: "user", content: "hi" }])!;
    expect(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"))).toEqual([{ role: "user", content: "hi" }]);
  });

  it("keeps the newest turns when the header would be too big", () => {
    const big = Array.from({ length: 8 }, (_, i) => ({ role: "user" as const, content: `${i}:` + "z".repeat(3_900) }));
    const encoded = encodeMessagesHeader(big)!;
    expect(encoded.length).toBeLessThanOrEqual(AD_HEADER_MAX_CHARS);
    const back = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as { content: string }[];
    expect(back.at(-1)!.content.startsWith("7:")).toBe(true);
  });

  it("builds an honest user agent", () => {
    expect(userAgentFor({ version: "1.0.30", os: "darwin", arch: "arm64" })).toBe(
      "qronos-cli/1.0.30 (darwin; arm64)",
    );
  });
});

describe("the email hash", () => {
  it("accepts 64 hex characters", () => {
    expect(cleanEmailHash(HASH)).toBe(HASH);
  });

  it("refuses an address, so an address can never be forwarded", () => {
    expect(cleanEmailHash("me@example.com")).toBeUndefined();
  });

  it("refuses a console log", () => {
    expect(cleanEmailHash("undefined")).toBeUndefined();
  });
});

describe("fetching the hash", () => {
  const deps = (body: unknown, status = 200) => {
    let calls = 0;
    return {
      baseUrl: "https://api.example",
      getToken: () => "jwt",
      fetchImpl: (async () => {
        calls += 1;
        return new Response(JSON.stringify(body), { status });
      }) as unknown as typeof fetch,
      calls: () => calls,
    };
  };

  it("returns the hash from /me", async () => {
    resetEmailHashCache();
    const d = deps({ email_hash: HASH });
    expect(await fetchEmailHash(d)).toBe(HASH);
  });

  it("caches, so a session does not ask twice", async () => {
    resetEmailHashCache();
    const d = deps({ email_hash: HASH });
    await fetchEmailHash(d);
    await fetchEmailHash(d);
    expect(d.calls()).toBe(1);
  });

  it("says nothing when the endpoint fails", async () => {
    resetEmailHashCache();
    expect(await fetchEmailHash(deps({ error: "nope" }, 500))).toBeUndefined();
  });

  it("says nothing when the field is not a hash", async () => {
    resetEmailHashCache();
    expect(await fetchEmailHash(deps({ email_hash: "me@example.com" }))).toBeUndefined();
  });

  it("survives a thrown network error", async () => {
    resetEmailHashCache();
    const failing = {
      baseUrl: "https://api.example",
      getToken: () => "jwt",
      fetchImpl: (async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch,
    };
    expect(await fetchEmailHash(failing)).toBeUndefined();
  });

  it("is off when the user opted out", async () => {
    resetEmailHashCache();
    expect(attributionEnabled({ QRONOS_NO_AD_ATTRIBUTION: "1" })).toBe(false);
    expect(startEmailHash({ baseUrl: "https://api.example", getToken: () => "jwt" }, { QRONOS_NO_AD_ATTRIBUTION: "1" })).toBeUndefined();
  });

  it("gives a getter that fills itself without blocking", async () => {
    resetEmailHashCache();
    const getter = startEmailHash(deps({ email_hash: HASH }), {})!;
    expect(typeof getter()).toBe("undefined"); // first call: nothing yet
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(getter()).toBe(HASH);
  });
});
