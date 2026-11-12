import { describe, expect, test } from "bun:test";
import {
  describeFetchFailure,
  fetchModels,
  modelListCandidates,
  parseModelList,
} from "../src/model-fetch";

describe("model list candidates: both /models and /v1/models", () => {
  test("a bare host tries /v1/models first, then /models", () => {
    expect(modelListCandidates("https://api.openai.com")).toEqual([
      "https://api.openai.com/v1/models",
      "https://api.openai.com/models",
    ]);
  });

  test("a base URL already ending in /v1 only appends /models", () => {
    expect(modelListCandidates("https://api.openai.com/v1")).toEqual(["https://api.openai.com/v1/models"]);
  });

  test("an Anthropic-compatible base URL without /v1 still works", () => {
    // The user pasted the host only; /models must be tried too.
    expect(modelListCandidates("https://api.anthropic.com")).toContain("https://api.anthropic.com/models");
  });

  test("a URL that is already a model endpoint is used as-is", () => {
    expect(modelListCandidates("https://x.test/v1/models")).toEqual(["https://x.test/v1/models"]);
  });

  test("trailing slashes are normalised away", () => {
    expect(modelListCandidates("https://api.test.com/v1///")).toEqual(["https://api.test.com/v1/models"]);
  });

  test("an empty base URL yields no candidates", () => {
    expect(modelListCandidates("   ")).toEqual([]);
  });
});

describe("parsing model lists", () => {
  test("OpenAI shape", () => {
    expect(parseModelList({ data: [{ id: "gpt-4o" }, { id: "gpt-4o-mini" }] })).toEqual([
      { id: "gpt-4o", name: "gpt-4o" },
      { id: "gpt-4o-mini", name: "gpt-4o-mini" },
    ]);
  });

  test("Anthropic shape uses display_name when present", () => {
    expect(parseModelList({ data: [{ id: "claude-x", display_name: "Claude X" }] })).toEqual([
      { id: "claude-x", name: "Claude X" },
    ]);
  });

  test("a bare array is accepted", () => {
    expect(parseModelList([{ id: "m1" }])).toEqual([{ id: "m1", name: "m1" }]);
  });

  test("duplicates are removed, keeping the first", () => {
    const out = parseModelList({ data: [{ id: "a" }, { id: "a" }] });
    expect(out).toHaveLength(1);
  });

  test("junk yields an empty list rather than throwing", () => {
    expect(parseModelList(null)).toEqual([]);
    expect(parseModelList({ nope: true })).toEqual([]);
    expect(parseModelList({ data: [{}, { id: 123 }] })).toEqual([]);
  });
});

describe("fetching models", () => {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  test("returns the list and which URL answered", async () => {
    const seen: string[] = [];
    const res = await fetchModels("https://api.test.com/v1", "k", {
      fetchImpl: (async (url: any) => {
        seen.push(String(url));
        return json({ data: [{ id: "m1" }] });
      }) as any,
    });
    expect(res.models).toEqual([{ id: "m1", name: "m1" }]);
    expect(res.source).toBe("https://api.test.com/v1/models");
    expect(seen).toHaveLength(1);
  });

  test("falls through to the second path when the first 404s", async () => {
    const seen: string[] = [];
    const res = await fetchModels("https://api.test.com", "k", {
      fetchImpl: (async (url: any) => {
        seen.push(String(url));
        if (String(url).endsWith("/v1/models")) return new Response("nope", { status: 404 });
        return json({ data: [{ id: "m2" }] });
      }) as any,
    });
    expect(res.models[0]?.id).toBe("m2");
    expect(seen).toHaveLength(2);
  });

  test("a reject on one path does not stop the search", async () => {
    const res = await fetchModels("https://api.test.com", "k", {
      fetchImpl: (async (url: any) => {
        if (String(url).endsWith("/v1/models")) throw new Error("dns");
        return json({ data: [{ id: "ok" }] });
      }) as any,
    });
    expect(res.models[0]?.id).toBe("ok");
  });

  test("an auth failure stops immediately instead of retrying paths", async () => {
    let calls = 0;
    const res = await fetchModels("https://api.test.com", "bad", {
      fetchImpl: (async () => {
        calls++;
        return new Response("no", { status: 401 });
      }) as any,
    });
    expect(res.failure).toBe("auth");
    expect(calls).toBe(1);
  });

  test("unreachable reports unreachable", async () => {
    const res = await fetchModels("https://api.test.com/v1", "k", {
      fetchImpl: (async () => {
        throw new Error("offline");
      }) as any,
    });
    expect(res.failure).toBe("unreachable");
    expect(res.models).toEqual([]);
  });

  test("answering but with no model list reports no-endpoint", async () => {
    const res = await fetchModels("https://api.test.com/v1", "k", {
      fetchImpl: (async () =>
        new Response("<html>hello</html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        })) as any,
    });
    expect(res.failure).toBe("no-endpoint");
  });

  test("sends the key in headers but never in the URL", async () => {
    let capturedUrl = "";
    let capturedHeaders: any;
    await fetchModels("https://api.test.com/v1", "secret-key", {
      fetchImpl: (async (url: any, init: any) => {
        capturedUrl = String(url);
        capturedHeaders = init?.headers ?? {};
        return json({ data: [{ id: "x" }] });
      }) as any,
    });
    expect(capturedUrl).not.toContain("secret-key");
    expect(capturedHeaders.Authorization).toBe("Bearer secret-key");
  });

  test("each failure mode has a human sentence", () => {
    expect(describeFetchFailure({ models: [], failure: "auth" })).toContain("401");
    expect(describeFetchFailure({ models: [], failure: "unreachable" })).toContain("Couldn't reach");
    expect(describeFetchFailure({ models: [], failure: "no-endpoint" })).toContain("doesn't publish");
  });
});
