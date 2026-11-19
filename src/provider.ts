// Built via `qronos.registerProvider(name, config)` per
// https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/custom-provider.md
import type { ProviderConfig } from "@earendil-works/pi-coding-agent";
import type { Api } from "@earendil-works/pi-ai";
import { CLI_VERSION } from "./version";

export const DEFAULT_PROVIDER_NAME = "qronos";

/**
 * Last-resort model id, used only when the user, the saved connection and the
 * server catalog all say nothing. `QRONOS_MODEL` overrides it, and a gateway
 * run that falls back this far prints a warning, so it is never silent.
 */
export const DEFAULT_MODEL_ID = process.env.QRONOS_MODEL || "claude-sonnet-5.5";

/**
 * Facts about a model that the provider config needs and the gateway catalog
 * does not always send: context window, max output, and price per 1M tokens.
 *
 * Why a table at all: the previous code told every non-Anthropic model it had
 * 1,048,576 tokens of context at $0.00/token. The footer meter, /context and
 * auto-compaction then fired at the wrong time, and /cost showed $0.00 for
 * models the user pays for directly. A small table plus a conservative
 * fallback is honest about what we know.
 */
export interface ModelFacts {
  contextWindow: number;
  maxTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

/** Conservative floor: most modern chat models accept at least 128k. */
export const SAFE_MODEL_FACTS: ModelFacts = {
  contextWindow: 128_000,
  maxTokens: 8_192,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

/** USD per 1M tokens. Unknown models fall back to SAFE_MODEL_FACTS (cost 0). */
const MODEL_FACTS: { match: RegExp; facts: ModelFacts }[] = [
  {
    match: /claude.*(opus)/i,
    facts: { contextWindow: 200_000, maxTokens: 8_192, cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 } },
  },
  {
    match: /claude.*(haiku)/i,
    facts: { contextWindow: 200_000, maxTokens: 8_192, cost: { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 } },
  },
  {
    match: /claude/i,
    facts: { contextWindow: 200_000, maxTokens: 8_192, cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } },
  },
  {
    match: /gpt-4o-mini/i,
    facts: { contextWindow: 128_000, maxTokens: 16_384, cost: { input: 0.15, output: 0.6, cacheRead: 0.075, cacheWrite: 0 } },
  },
  {
    match: /gpt-4\.1|gpt-4-1/i,
    facts: { contextWindow: 1_047_576, maxTokens: 32_768, cost: { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 0 } },
  },
  {
    match: /gpt-4o/i,
    facts: { contextWindow: 128_000, maxTokens: 16_384, cost: { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 0 } },
  },
  {
    match: /deepseek/i,
    facts: { contextWindow: 128_000, maxTokens: 8_192, cost: { input: 0.27, output: 1.1, cacheRead: 0.07, cacheWrite: 0 } },
  },
  {
    match: /llama-?3(\.3)?-70b/i,
    facts: { contextWindow: 128_000, maxTokens: 8_192, cost: { input: 0.59, output: 0.79, cacheRead: 0, cacheWrite: 0 } },
  },
  {
    match: /llama-?3(\.1)?-8b/i,
    facts: { contextWindow: 128_000, maxTokens: 8_192, cost: { input: 0.05, output: 0.08, cacheRead: 0, cacheWrite: 0 } },
  },
  {
    match: /gemini/i,
    facts: { contextWindow: 1_000_000, maxTokens: 8_192, cost: { input: 1.25, output: 5, cacheRead: 0.31, cacheWrite: 0 } },
  },
];

/** Look up what we know about a model id; never throws, never returns undefined. */
export function modelFacts(modelId: string): ModelFacts {
  for (const row of MODEL_FACTS) {
    if (row.match.test(modelId)) return row.facts;
  }
  return SAFE_MODEL_FACTS;
}

export const SAFE_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;

export interface CatalogModel {
  id: string;
  name: string;
  /** Server-reported limits win over the local table when present. */
  contextWindow?: number;
  maxTokens?: number;
}

export interface ProviderOptions {
  providerName?: string;
  baseUrl?: string;
  apiKey?: string;
  modelId?: string;
  sessionId: string;
  models?: CatalogModel[];
}

export function completionsBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

interface ProviderPreset {
  name: string;
  baseUrl: string;
  api: Api;
  defaultModel: string;
  envKey: string;
}

export const PROVIDER_PRESETS: Record<string, ProviderPreset> = {
  qronos: {
    name: "qronos",
    baseUrl: "https://api.qronos.me/v1",
    api: "openai-completions",
    defaultModel: "claude-sonnet-5.5",
    envKey: "QRONOS_API_KEY",
  },
  openai: {
    name: "openai",
    baseUrl: "https://api.openai.com/v1",
    api: "openai-completions",
    defaultModel: "gpt-4o",
    envKey: "OPENAI_API_KEY",
  },
  anthropic: {
    name: "anthropic",
    baseUrl: "https://api.anthropic.com",
    api: "anthropic-messages",
    defaultModel: "claude-3-7-sonnet-latest",
    envKey: "ANTHROPIC_API_KEY",
  },
  deepseek: {
    name: "deepseek",
    baseUrl: "https://api.deepseek.com/v1",
    api: "openai-completions",
    defaultModel: "deepseek-chat",
    envKey: "DEEPSEEK_API_KEY",
  },
  openrouter: {
    name: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    api: "openai-completions",
    defaultModel: "anthropic/claude-3.7-sonnet",
    envKey: "OPENROUTER_API_KEY",
  },
  groq: {
    name: "groq",
    baseUrl: "https://api.groq.com/openai/v1",
    api: "openai-completions",
    defaultModel: "llama-3.3-70b-versatile",
    envKey: "GROQ_API_KEY",
  },
  ollama: {
    name: "ollama",
    baseUrl: "http://localhost:11434/v1",
    api: "openai-completions",
    defaultModel: "llama3",
    envKey: "OLLAMA_API_KEY",
  },
};

export function buildProviderConfig(opts: ProviderOptions): ProviderConfig {
  const providerKey = (opts.providerName || "qronos").toLowerCase();
  const preset = PROVIDER_PRESETS[providerKey];

  const api: Api = preset ? preset.api : "openai-completions";
  const rawBaseUrl = opts.baseUrl || preset?.baseUrl || "https://api.qronos.me/v1";
  const baseUrl = api === "anthropic-messages" ? rawBaseUrl.replace(/\/+$/, "") : completionsBaseUrl(rawBaseUrl);

  const activeModelId = opts.modelId || preset?.defaultModel || DEFAULT_MODEL_ID;
  const models: CatalogModel[] = opts.models && opts.models.length > 0
    ? opts.models
    : [{ id: activeModelId, name: activeModelId }];

  const headers: Record<string, string> = {
    "x-session-id": opts.sessionId,
    "x-client-version": CLI_VERSION,
    // Tells the gateway this is the terminal CLI, not the VS Code extension and
    // not an unknown SDK caller. The admin live-request panel reads it to show a
    // "QRONOS CLI" badge instead of "API". See qronos-ai/server/clientTag.ts.
    "x-qronos-client": "cli",
  };

  return {
    name: preset?.name || providerKey,
    baseUrl,
    apiKey: opts.apiKey || "",
    api,
    headers,
    models: models.map((m) => {
      const facts = modelFacts(m.id);
      return {
        id: m.id,
        name: m.name,
        reasoning: true,
        thinkingLevelMap: {
          off: "off",
          minimal: "minimal",
          low: "low",
          medium: "medium",
          high: "high",
          xhigh: "xhigh",
          max: "max",
        },
        input: ["text"] as const,
        cost: facts.cost,
        contextWindow: m.contextWindow && m.contextWindow > 0 ? m.contextWindow : facts.contextWindow,
        maxTokens: m.maxTokens && m.maxTokens > 0 ? m.maxTokens : facts.maxTokens,
      };
    }),
  };
}

export const PROVIDER_NAME = DEFAULT_PROVIDER_NAME;
export const MODEL_ID = DEFAULT_MODEL_ID;
