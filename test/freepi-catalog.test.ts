// The model catalogue: parse, cache, fall back. No network in these tests.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CATALOG_TTL_MS,
  catalogSourceText,
  loadFreepiCatalog,
  mergeCatalog,
  parseFreepiCatalog,
  cleanModelName,
  readFreepiCatalogCache,
  writeFreepiCatalogCache,
} from "../src/freepi-catalog";
import { FREEPI_PROVIDER_MODELS } from "../src/freepi-models";

const made: string[] = [];
function tempPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "qronos-catalog-"));
  made.push(dir);
  return join(dir, "freepi-models.json");
}
afterEach(() => {
  while (made.length > 0) {
    const dir = made.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

const serverCatalog = [
  { id: "particle", display_name: "Particle", context_window: 200_000, max_tokens: 32_000 },
  { id: "deepseek-v4.1-flash", context_window: 131_072 },
  { id: "some-paid-model", context_window: 999_999 },
];

describe("parseFreepiCatalog", () => {
  test("a flat array of objects", () => {
    expect(parseFreepiCatalog(serverCatalog)).toHaveLength(3);
  });

  test("`{ models: [...] }` and `{ data: [...] }`", () => {
    expect(parseFreepiCatalog({ models: serverCatalog })).toHaveLength(3);
    expect(parseFreepiCatalog({ data: serverCatalog })).toHaveLength(3);
  });

  test("a list of bare ids", () => {
    expect(parseFreepiCatalog({ models: ["particle", "glm-5.3-flash"] })).toEqual([
      { id: "particle", name: "particle" },
      { id: "glm-5.3-flash", name: "glm-5.3-flash" },
    ]);
  });

  test("numbers arrive as strings too", () => {
    const [first] = parseFreepiCatalog([{ id: "particle", context_window: "200000" }]);
    expect(first?.contextWindow).toBe(200_000);
  });

  test("junk gives an empty list, never a throw", () => {
    expect(parseFreepiCatalog(undefined)).toEqual([]);
    expect(parseFreepiCatalog({ nope: true })).toEqual([]);
    expect(parseFreepiCatalog([1, null, {}])).toEqual([]);
  });

  test("both names of one model collapse to one row", () => {
    expect(parseFreepiCatalog([{ id: "particle" }, { id: "particle" }])).toHaveLength(1);
  });
});

describe("mergeCatalog", () => {
  test("the four free models keep our names and order, and take the server's numbers", () => {
    const merged = mergeCatalog(FREEPI_PROVIDER_MODELS, parseFreepiCatalog(serverCatalog));
    expect(merged.map((m) => m.id)).toEqual(FREEPI_PROVIDER_MODELS.map((m) => m.id));
    // the server's display name is the real product name
    // "Particle" is only the id with a capital letter, so our label stays; the
    // real product name in the live payload is "Particle-1".
    expect(merged[0]!.name).toBe("Particle (free)");
    expect(merged[0]!.contextWindow).toBe(200_000);
    expect(merged[0]!.maxTokens).toBe(32_000);
  });

  test("a model the server does not list keeps our floors and our name", () => {
    const merged = mergeCatalog(FREEPI_PROVIDER_MODELS, []);
    expect(merged[0]!.contextWindow).toBe(FREEPI_PROVIDER_MODELS[0]!.contextWindow);
    expect(merged[0]!.name).toBe(FREEPI_PROVIDER_MODELS[0]!.name);
  });

  test("a display name equal to the id does not replace our clearer label", () => {
    const merged = mergeCatalog(FREEPI_PROVIDER_MODELS, [{ id: "particle", name: "particle" }]);
    expect(merged[0]!.name).toBe(FREEPI_PROVIDER_MODELS[0]!.name);
  });

  test("a paid model never slips into the free list", () => {
    const merged = mergeCatalog(FREEPI_PROVIDER_MODELS, parseFreepiCatalog(serverCatalog));
    expect(merged.some((m) => m.id === "some-paid-model")).toBe(false);
  });
});

describe("cache file", () => {
  test("written and read back", () => {
    const path = tempPath();
    writeFreepiCatalogCache(path, parseFreepiCatalog(serverCatalog));
    const read = readFreepiCatalogCache(path);
    expect(read?.models).toHaveLength(3);
    expect(read?.version).toBe(1);
    expect(readFileSync(path, "utf8")).not.toContain("token");
  });

  test("a broken file reads as no file", () => {
    const path = tempPath();
    writeFileSync(path, "{not json");
    expect(readFreepiCatalogCache(path)).toBeUndefined();
  });

  test("a well-formed file with no models is ignored", () => {
    const path = tempPath();
    writeFileSync(path, JSON.stringify({ version: 1, fetchedAt: new Date().toISOString(), models: [] }));
    expect(readFreepiCatalogCache(path)).toBeUndefined();
  });
});

describe("loadFreepiCatalog", () => {
  test("a fresh cache is used and no request is made", async () => {
    const path = tempPath();
    writeFreepiCatalogCache(path, parseFreepiCatalog(serverCatalog));
    let calls = 0;
    const result = await loadFreepiCatalog({
      path,
      fetchImpl: (async () => {
        calls += 1;
        return Response.json({});
      }) as unknown as typeof fetch,
    });
    expect(calls).toBe(0);
    expect(result.source).toBe("cache");
    expect(result.models[0]!.contextWindow).toBe(200_000);
  });

  test("a stale cache is replaced by the network answer, which is cached", async () => {
    const path = tempPath();
    writeFreepiCatalogCache(path, parseFreepiCatalog([]));
    // An hour and one second old
    writeFileSync(
      path,
      JSON.stringify({ version: 1, fetchedAt: new Date(Date.now() - CATALOG_TTL_MS - 1_000).toISOString(), models: [{ id: "particle", context_window: 1 }] }),
    );
    const result = await loadFreepiCatalog({
      path,
      fetchImpl: (async () => Response.json({ models: serverCatalog })) as unknown as typeof fetch,
    });
    expect(result.source).toBe("network");
    expect(result.models[0]!.contextWindow).toBe(200_000);
    // only the four free rows are cached, never the whole catalogue
    expect(readFreepiCatalogCache(path)?.models).toHaveLength(4);
  });

  test("no network and a stale cache: the cache answers, the reason is kept", async () => {
    const path = tempPath();
    writeFileSync(
      path,
      JSON.stringify({ version: 1, fetchedAt: new Date(Date.now() - CATALOG_TTL_MS - 1_000).toISOString(), models: serverCatalog }),
    );
    const result = await loadFreepiCatalog({
      path,
      fetchImpl: (async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch,
    });
    expect(result.source).toBe("cache");
    expect(result.note).toContain("offline");
  });

  test("no network and no cache: the built-in four", async () => {
    const path = tempPath();
    const result = await loadFreepiCatalog({
      path,
      fetchImpl: (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch,
    });
    expect(result.source).toBe("builtin");
    expect(result.models).toHaveLength(4);
    expect(result.note).toContain("500");
  });

  test("a catalogue with no usable models falls back instead of emptying /model", async () => {
    const path = tempPath();
    const result = await loadFreepiCatalog({
      path,
      fetchImpl: (async () => Response.json({ models: [] })) as unknown as typeof fetch,
    });
    expect(result.source).toBe("builtin");
    expect(result.models).toHaveLength(4);
  });
});

describe("catalogSourceText", () => {
  test("built-in says so and why", () => {
    expect(catalogSourceText({ models: [], source: "builtin", note: "http 500" })).toBe("models: built-in four (http 500)");
  });

  test("network says free-pi, with the age", () => {
    const text = catalogSourceText({ models: [], source: "network", fetchedAt: Date.now() - 5 * 60_000 });
    expect(text).toContain("the server");
    expect(text).toContain("5m");
  });

  test("cache says cache", () => {
    expect(catalogSourceText({ models: [], source: "cache", fetchedAt: Date.now() })).toContain("cache");
  });
});

describe("cleanModelName", () => {
  test("the marketing tail is dropped", () => {
    expect(cleanModelName("Particle-1 · 🔥 Free Unlimited: limited time", "particle")).toBe("Particle-1");
  });

  test("emoji alone are removed, the words stay", () => {
    expect(cleanModelName("🔥 DeepSeek V4.1 Flash", "deepseek-v4.1-flash")).toBe("DeepSeek V4.1 Flash");
  });

  test("a name that only repeats the id is no name", () => {
    expect(cleanModelName("particle", "particle")).toBeUndefined();
    expect(cleanModelName("Particle", "particle")).toBeUndefined();
  });

  test("nothing left, or nothing given, is undefined", () => {
    expect(cleanModelName(undefined, "particle")).toBeUndefined();
    expect(cleanModelName(" · 🔥 Free", "particle")).toBeUndefined();
  });

  test("a very long name is cut, never a broken line", () => {
    expect(cleanModelName("A".repeat(80), "particle")!.length).toBe(48);
  });

  test("the real live payload now reads well", () => {
    const live = [
      { id: "particle", name: "Particle-1 · 🔥 Free Unlimited: limited time" },
      { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash · 🔥 Free Unlimited: limited time" },
    ];
    // `name` is read as a display name, which is exactly how free-pi sends it.
    const parsed = parseFreepiCatalog(live);
    expect(parsed.map((m) => m.name)).toEqual(["Particle-1", "DeepSeek V4.1 Flash"]);
  });
});
