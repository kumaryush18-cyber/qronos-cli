import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activeConnection,
  keyEnvNames,
  loadConnectionFile,
  providerNameFromUrl,
  redactConnection,
  rememberConnection,
  resolveConnectionKey,
  saveConnectionFile,
} from "../src/connection-store";

const dirs: string[] = [];

async function tempFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "qronos-conn-"));
  dirs.push(dir);
  return join(dir, "connections.json");
}

afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

describe("connection store: round trip", () => {
  test("remembers a connection and marks it active", async () => {
    const path = await tempFile();
    await rememberConnection(path, { baseUrl: "https://api.test.com/v1", provider: "test", model: "m1" });
    const file = await loadConnectionFile(path);
    expect(activeConnection(file)?.model).toBe("m1");
    expect(file.active).toBe("test");
  });

  test("a missing file reads as empty, not an error", async () => {
    expect(await loadConnectionFile(await tempFile())).toEqual({ connections: {} });
  });

  test("a corrupt file reads as empty instead of crashing startup", async () => {
    const path = await tempFile();
    await saveConnectionFile(path, { connections: {} });
    await Bun.write(path, "{not json");
    expect(await loadConnectionFile(path)).toEqual({ connections: {} });
  });

  test("invalid entries are dropped, valid ones kept", async () => {
    const path = await tempFile();
    await Bun.write(
      path,
      JSON.stringify({
        active: "good",
        connections: {
          good: { baseUrl: "https://a.test", provider: "good", model: "m" },
          bad: { provider: "bad" },
        },
      }),
    );
    const file = await loadConnectionFile(path);
    expect(Object.keys(file.connections)).toEqual(["good"]);
  });

  test("the file is written 0600", async () => {
    const path = await tempFile();
    await saveConnectionFile(path, { connections: {} });
    const mode = (await stat(path)).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe("connection store: the key is not stored by default", () => {
  test("a saved connection has no inline key", async () => {
    const path = await tempFile();
    await rememberConnection(path, { baseUrl: "https://a.test", provider: "a", model: "m" });
    const raw = await readFile(path, "utf8");
    expect(raw).not.toContain("inlineApiKey");
  });

  test("after saving, the key is read from the environment", async () => {
    const path = await tempFile();
    await rememberConnection(path, { baseUrl: "https://a.test", provider: "openai", model: "m" });
    const conn = activeConnection(await loadConnectionFile(path))!;
    expect(resolveConnectionKey(conn, { OPENAI_API_KEY: "sk-env" } as any)).toBe("sk-env");
  });

  test("an inline key is honoured when explicitly stored", () => {
    const key = resolveConnectionKey(
      { baseUrl: "https://a.test", provider: "a", model: "m", inlineApiKey: "sk-inline" },
      {} as any,
    );
    expect(key).toBe("sk-inline");
  });

  test("no key anywhere resolves to undefined", () => {
    expect(resolveConnectionKey({ baseUrl: "https://a.test", provider: "z", model: "m" }, {} as any)).toBeUndefined();
  });

  test("redactConnection never reveals the key itself", () => {
    const redacted = redactConnection({
      baseUrl: "https://a.test",
      provider: "openai",
      model: "m",
      inlineApiKey: "sk-SUPER-SECRET",
    });
    const serialised = JSON.stringify(redacted);
    expect(serialised).not.toContain("sk-SUPER-SECRET");
    expect(redacted.apiKey).toContain("stored inline");
  });
});

describe("connection store: naming helpers", () => {
  test("env var names derive from the provider label", () => {
    expect(keyEnvNames("openai")[0]).toBe("OPENAI_API_KEY");
    expect(keyEnvNames("my-provider")[0]).toBe("MY_PROVIDER_API_KEY");
  });

  test("provider name is inferred from a URL when the user leaves it blank", () => {
    expect(providerNameFromUrl("https://api.openai.com/v1")).toBe("openai");
    expect(providerNameFromUrl("https://api.deepseek.com")).toBe("deepseek");
    expect(providerNameFromUrl("http://localhost:11434/v1")).toBe("local");
  });

  test("a nonsense URL still yields a usable label", () => {
    expect(providerNameFromUrl("not a url")).toBe("custom");
  });
});
