// Model facts: the provider must not claim a fake 1M context and $0 cost.
import { describe, expect, test } from "bun:test";
import { modelFacts, SAFE_MODEL_FACTS, buildProviderConfig } from "../src/provider";

describe("modelFacts", () => {
  test("claude models get 200k context and a real price, not $0", () => {
    const facts = modelFacts("claude-sonnet-4-5");
    expect(facts.contextWindow).toBe(200_000);
    expect(facts.cost.input).toBeGreaterThan(0);
    expect(facts.cost.output).toBeGreaterThan(0);
  });

  test("gpt-4o is 128k, not 1M", () => {
    expect(modelFacts("gpt-4o").contextWindow).toBe(128_000);
    expect(modelFacts("gpt-4o-mini").contextWindow).toBe(128_000);
  });

  test("deepseek and llama get their real prices", () => {
    expect(modelFacts("deepseek-chat").cost.input).toBe(0.27);
    expect(modelFacts("llama-3.3-70b-versatile").contextWindow).toBe(128_000);
  });

  test("gemini keeps its 1M window", () => {
    expect(modelFacts("gemini-2.5-pro").contextWindow).toBe(1_000_000);
  });

  test("an unknown model falls back to the conservative 128k floor", () => {
    expect(modelFacts("totally-unknown-model")).toEqual(SAFE_MODEL_FACTS);
    expect(SAFE_MODEL_FACTS.contextWindow).toBe(128_000);
  });

  test("a server-reported contextWindow wins over the local table", () => {
    const config = buildProviderConfig({
      providerName: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
      sessionId: "s",
      models: [{ id: "gpt-4o", name: "GPT-4o", contextWindow: 64_000, maxTokens: 4_096 }],
    });
    const model = config.models?.[0];
    expect(model && "contextWindow" in model ? model.contextWindow : undefined).toBe(64_000);
    expect(model && "maxTokens" in model ? model.maxTokens : undefined).toBe(4_096);
  });
});

describe("admin panel client tag", () => {
  test("the CLI marks itself as the terminal client", () => {
    // qronos-ai/server/clientTag.ts reads this header and shows "QRONOS CLI"
    // in the live-request panel instead of the generic "API" badge.
    const config = buildProviderConfig({
      providerName: "qronos",
      apiKey: "sk-test",
      sessionId: "s",
    });
    expect(config.headers?.["x-qronos-client"]).toBe("cli");
    expect(config.headers?.["x-session-id"]).toBe("s");
  });

  test("the header survives a custom base url and model", () => {
    const config = buildProviderConfig({
      providerName: "qronos",
      baseUrl: "https://api.qronos.me/v1",
      apiKey: "sk-test",
      sessionId: "abc",
      modelId: "glm-5.3-flash",
    });
    expect(config.headers?.["x-qronos-client"]).toBe("cli");
  });
});
