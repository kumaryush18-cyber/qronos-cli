// Built via `pi.registerProvider(name, config)` per
// https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/custom-provider.md
import type { ProviderConfig } from "@earendil-works/pi-coding-agent";
import type { Api } from "@earendil-works/pi-ai";
import { CLI_VERSION } from "./version";

export const DEFAULT_PROVIDER_NAME = "qronos";
export const DEFAULT_MODEL_ID = "deepseek/deepseek-v4-flash";

export const SAFE_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;

export interface CatalogModel {
  id: string;
  name: string;
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
    defaultModel: "deepseek/deepseek-v4-flash",
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
  };

  return {
    name: preset?.name || providerKey,
    baseUrl,
    apiKey: opts.apiKey || "",
    api,
    headers,
    models: models.map((m) => ({
      id: m.id,
      name: m.name,
      reasoning: false,
      input: ["text"] as const,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: api === "anthropic-messages" ? 200_000 : 1_048_576,
      maxTokens: 8192,
    })),
  };
}

export const PROVIDER_NAME = DEFAULT_PROVIDER_NAME;
export const MODEL_ID = DEFAULT_MODEL_ID;
