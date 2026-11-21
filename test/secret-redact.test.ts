import { describe, expect, test } from "bun:test";
import { REDACTED, cleanText, looksLikeSecret, redactSecrets } from "../src/secret-redact";

describe("redactSecrets: token shapes", () => {
  test("an sk- key is removed", () => {
    expect(redactSecrets("key sk-abcdef0123456789abcdef here")).toBe(`key ${REDACTED} here`);
  });

  test("a GitHub classic token is removed", () => {
    expect(redactSecrets("push with ghp_abcdefghijklmnopqrstuvwxyz012345")).toContain(REDACTED);
  });

  test("a fine-grained GitHub token is removed", () => {
    expect(redactSecrets("github_pat_11ABCDEFG0123456789_abcdefghijklmnop")).toContain(REDACTED);
  });

  test("an AWS access key id is removed", () => {
    expect(redactSecrets("AKIAIOSFODNN7EXAMPLE")).toBe(REDACTED);
  });

  test("a Slack token is removed", () => {
    expect(redactSecrets("xoxb-1234567890-abcdefghij")).toContain(REDACTED);
  });

  test("a Stripe key is removed", () => {
    expect(redactSecrets("sk_live_abcdefghijklmnop1234")).toContain(REDACTED);
  });

  test("a Google API key is removed", () => {
    expect(redactSecrets("AIzaSyD-abcdefghijklmnopqrstuvwxyz1234567")).toContain(REDACTED);
  });

  test("a Telegram bot token is removed", () => {
    expect(redactSecrets("8123456789:AAF-abcdefghijklmnopqrstuvwxyz01234")).toContain(REDACTED);
  });

  test("a JWT is removed", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    expect(redactSecrets(`token ${jwt}`)).toBe(`token ${REDACTED}`);
  });

  test("a private key block is removed wholesale", () => {
    const pem = "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\nBBBB\n-----END OPENSSH PRIVATE KEY-----";
    expect(redactSecrets(`here ${pem} done`)).toBe(`here ${REDACTED} done`);
  });
});

describe("redactSecrets: assignments and URLs", () => {
  test("password=value keeps the name and quote style", () => {
    expect(redactSecrets('password="hunter2hunter2"')).toBe(`password="${REDACTED}"`);
  });

  test("api_key: value is redacted", () => {
    expect(redactSecrets("api_key: abcdef123456")).toBe(`api_key: ${REDACTED}`);
  });

  test("a short value is left alone (prose, not a secret)", () => {
    expect(redactSecrets("token: none")).toBe("token: none");
    expect(redactSecrets("password: yes")).toBe("password: yes");
  });

  test("Authorization: Bearer keeps the prefix", () => {
    expect(redactSecrets("Authorization: Bearer abcdefghijklmnop")).toBe(
      `Authorization: Bearer ${REDACTED}`,
    );
  });

  test("credentials inside a URL are removed", () => {
    expect(redactSecrets("https://user:s3cretpass@github.com/x/y")).toBe(
      `https://${REDACTED}@github.com/x/y`,
    );
  });
});

describe("redactSecrets: safety properties", () => {
  test("plain prose is untouched", () => {
    const prose = "The token budget is 1200 tokens per prompt, and the password field is validated.";
    expect(redactSecrets(prose)).toBe(prose);
  });

  test("code with no secrets is untouched", () => {
    const code = 'const token = await getToken();\nif (!token) throw new Error("no token");';
    expect(redactSecrets(code)).toBe(code);
  });

  test("it is idempotent", () => {
    const input = "password=abcdefgh1234 and sk-abcdefghijklmnop1234";
    const once = redactSecrets(input);
    expect(redactSecrets(once)).toBe(once);
  });

  test("an already redacted value is not double-redacted", () => {
    expect(redactSecrets(`password=${REDACTED}`)).toBe(`password=${REDACTED}`);
  });

  test("empty and non-string input return empty", () => {
    expect(redactSecrets("")).toBe("");
    expect(redactSecrets(undefined as unknown as string)).toBe("");
  });

  test("multiple secrets on one line are all removed", () => {
    const line = "AKIAIOSFODNN7EXAMPLE and ghp_abcdefghijklmnopqrstuvwxyz012345";
    const out = redactSecrets(line);
    expect(out).not.toContain("AKIA");
    expect(out).not.toContain("ghp_");
  });
});

describe("looksLikeSecret", () => {
  test("true for a key, false for ordinary text", () => {
    expect(looksLikeSecret("sk-abcdefghijklmnop1234")).toBe(true);
    expect(looksLikeSecret("we fixed the flaky test")).toBe(false);
  });

  test("false for empty input", () => {
    expect(looksLikeSecret("")).toBe(false);
  });
});

describe("cleanText", () => {
  test("redacts then clamps with a visible marker", () => {
    const out = cleanText("ghp_abcdefghijklmnopqrstuvwxyz012345 and more text", 20);
    expect(out.length).toBeLessThanOrEqual(20);
    expect(out).toContain(REDACTED);
    expect(out.endsWith("…")).toBe(true);
  });

  test("short text is returned unchanged", () => {
    expect(cleanText("short", 100)).toBe("short");
  });

  test("CRLF becomes LF", () => {
    expect(cleanText("a\r\nb", 100)).toBe("a\nb");
  });

  test("a zero budget returns empty", () => {
    expect(cleanText("anything", 0)).toBe("");
  });
});
