import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normaliseBaseUrl, renderMenu, runByok, runFirstRun, type FirstRunDeps } from "../src/first-run";
import { loadConnectionFile } from "../src/connection-store";

const dirs: string[] = [];

async function tempPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "qronos-first-"));
  dirs.push(dir);
  return join(dir, "connections.json");
}

afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

/** Build deps that answer prompts from a script and record everything logged. */
function fakeDeps(answers: string[], secrets: string[] = [], over: Partial<FirstRunDeps> = {}) {
  const logLines: string[] = [];
  const asked: string[] = [];
  let ai = 0;
  let si = 0;
  const deps: FirstRunDeps = {
    log: (m) => logLines.push(m),
    ask: async (q) => {
      asked.push(q);
      return answers[ai++] ?? "";
    },
    askSecret: async (q) => {
      asked.push(q);
      return secrets[si++] ?? "";
    },
    gatewaySignIn: async () => undefined,
    ...over,
  };
  return { deps, logLines, asked };
}

const okModels = (ids: string[]) =>
  ({ fetchModels: async () => ({ models: ids.map((id) => ({ id, name: id })) }) }) as Partial<FirstRunDeps>;

describe("first-run menu", () => {
  test("offers exactly two choices, gateway first", () => {
    const menu = renderMenu(0);
    expect(menu).toContain("Sign in to Qronos Gateway");
    expect(menu).toContain("Use my own API key");
    // Gateway appears before the key option.
    expect(menu.indexOf("Gateway")).toBeLessThan(menu.indexOf("own API key"));
  });

  test("shows no local-model option", () => {
    expect(renderMenu(1).toLowerCase()).not.toContain("local model");
  });

  test("blank input selects the gateway (the default)", async () => {
    const { deps } = fakeDeps([""], [], { gatewaySignIn: async () => "tok-123" });
    const outcome = await runFirstRun(deps);
    expect(outcome).toEqual({ kind: "gateway", token: "tok-123" });
  });

  test("a failing gateway returns to the menu instead of exiting", async () => {
    let calls = 0;
    const { deps, logLines } = fakeDeps(["1", "q"], [], {
      gatewaySignIn: async () => {
        calls++;
        throw new Error("offline");
      },
    });
    const outcome = await runFirstRun(deps);
    expect(calls).toBe(1);
    expect(outcome).toEqual({ kind: "quit" });
    expect(logLines.join("\n")).toContain("Couldn't complete sign-in");
  });

  test("an invalid choice re-prompts rather than crashing", async () => {
    const { deps, logLines } = fakeDeps(["xyz", "q"]);
    const outcome = await runFirstRun(deps);
    expect(outcome).toEqual({ kind: "quit" });
    expect(logLines.join("\n")).toContain("Not a valid choice");
  });
});

describe("first-run: use my own API key", () => {
  test("asks exactly the three fields", async () => {
    const { deps, asked } = fakeDeps(
      ["https://api.test.com/v1", "test", "1", "n"],
      ["sk-secret"],
      okModels(["m1"]),
    );
    const outcome = await runByok(deps);
    expect(outcome?.kind).toBe("byok");
    const text = asked.join("\n");
    expect(text).toContain("Base URL");
    expect(text).toContain("Provider name");
    expect(text).toContain("API key");
    expect(text).toContain("Model");
  });

  test("fetches models and uses the chosen one", async () => {
    const { deps } = fakeDeps(
      ["https://api.test.com/v1", "test", "2", "n"],
      ["sk-secret"],
      okModels(["first", "second"]),
    );
    const outcome = await runByok(deps);
    expect(outcome?.kind).toBe("byok");
    if (outcome?.kind === "byok") expect(outcome.connection.model).toBe("second");
  });

  test("a typed model name is accepted even when not listed", async () => {
    const { deps } = fakeDeps(
      ["https://api.test.com/v1", "test", "my-custom-model", "n"],
      ["sk-secret"],
      okModels(["a", "b"]),
    );
    const outcome = await runByok(deps);
    if (outcome?.kind === "byok") expect(outcome.connection.model).toBe("my-custom-model");
  });

  test("a rejected key stops the flow and saves nothing", async () => {
    const path = await tempPath();
    const { deps, logLines } = fakeDeps(["https://api.test.com/v1", "test"], ["bad-key"], {
      connectionsPath: path,
      fetchModels: async () => ({ models: [], failure: "auth" as const }),
    });
    expect(await runByok(deps)).toBeUndefined();
    expect(logLines.join("\n")).toContain("rejected the key");
    expect(await loadConnectionFile(path)).toEqual({ connections: {} });
  });

  test("an endpoint with no model list falls back to typing a name", async () => {
    const { deps } = fakeDeps(["https://api.test.com/v1", "test", "gpt-4o", "n"], ["k"], {
      fetchModels: async () => ({ models: [], failure: "no-endpoint" as const }),
    });
    const outcome = await runByok(deps);
    if (outcome?.kind === "byok") expect(outcome.connection.model).toBe("gpt-4o");
  });

  test("an unparseable base URL returns to the menu without asking for a key", async () => {
    const { deps } = fakeDeps(["http://:bad:"]);
    expect(await runByok(deps)).toBeUndefined();
  });

  test("saving writes the endpoint but never the key by default", async () => {
    const path = await tempPath();
    const { deps } = fakeDeps(["https://api.test.com/v1", "test", "1", "y", "n"], ["sk-secret"], {
      connectionsPath: path,
      ...okModels(["m1"]),
    });
    await runByok(deps);

    const raw = await readFile(path, "utf8");
    expect(raw).toContain("api.test.com");
    expect(raw).not.toContain("sk-secret");
    expect(raw).not.toContain("inlineApiKey");
  });

  test("the key is stored only when explicitly opted in", async () => {
    const path = await tempPath();
    const { deps } = fakeDeps(["https://api.test.com/v1", "test", "1", "y", "y"], ["sk-secret"], {
      connectionsPath: path,
      ...okModels(["m1"]),
    });
    await runByok(deps);
    const file = await loadConnectionFile(path);
    expect(file.connections.test?.inlineApiKey).toBe("sk-secret");
  });

  test("declining to save keeps it as a session-only connection", async () => {
    const path = await tempPath();
    const { deps, logLines } = fakeDeps(["https://api.test.com/v1", "test", "1", "n"], ["k"], {
      connectionsPath: path,
      ...okModels(["m1"]),
    });
    const outcome = await runByok(deps);
    expect(outcome?.kind).toBe("byok");
    expect(await loadConnectionFile(path)).toEqual({ connections: {} });
    expect(logLines.join("\n")).toContain("session only");
  });

  test("the key is never echoed in any output", async () => {
    const { deps, logLines } = fakeDeps(["https://api.test.com/v1", "test", "1", "y", "n"], ["sk-TOPSECRET"], {
      ...okModels(["m1"]),
    });
    await runByok(deps);
    expect(logLines.join("\n")).not.toContain("sk-TOPSECRET");
  });
});

describe("base URL normalisation", () => {
  test("adds https:// when the scheme is missing", () => {
    expect(normaliseBaseUrl("api.openai.com/v1")).toBe("https://api.openai.com/v1");
  });

  test("removes trailing slashes", () => {
    expect(normaliseBaseUrl("https://api.test.com/v1///")).toBe("https://api.test.com/v1");
  });

  test("keeps http for local endpoints", () => {
    expect(normaliseBaseUrl("http://localhost:11434/v1")).toBe("http://localhost:11434/v1");
  });

  test("rejects nonsense", () => {
    expect(normaliseBaseUrl("http://")).toBeUndefined();
    expect(normaliseBaseUrl("")).toBeUndefined();
  });
});
