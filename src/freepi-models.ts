// The four models free-pi gives away, and the facts we are willing to claim
// about them.
//
// Where these come from: free-pi's own docs. The server's real catalogue
// (`GET /client-version`) is not read here yet — that lands in F3 with the ads
// bridge — so anything the docs do not say is left at a conservative floor
// rather than invented.
//
// The context window below is a floor, not a promise: free-pi publishes no
// number we can verify, and a wrong big number would make pi skip the
// compaction it should have done. 128k is what almost every modern model
// accepts, so it is safe to assume and honest to keep small.
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

export const FREEPI_PROVIDER_NAME = "free";
export const FREEPI_PROVIDER_LABEL = "free";
/**
 * The origin, for the routes that live at the root: `/ads/next` and
 * `/ads/impression`. The `/v1` prefix belongs to chat completions only, and
 * using it for ads asks the wrong address (a real bug the ad tests caught).
 */
export const FREEPI_ROOT_URL = "https://api.freepi.ai";
/** The model API: chat completions. */
export const FREEPI_BASE_URL = `${FREEPI_ROOT_URL}/v1`;

/** Conservative facts until the real catalogue is fetched. */
export const FREEPI_CONTEXT_WINDOW = 128_000;
export const FREEPI_MAX_TOKENS = 16_384;

export interface FreepiModelSpec {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
}

/** One row of the server's catalogue: only the facts we use. */
export interface FreepiCatalogModel {
  id: string;
  name: string;
  contextWindow?: number;
  maxTokens?: number;
}

/**
 * The four free models, in the order free-pi lists them.
 *
 * The model ids are exactly what the API accepts: `deepseek-v4.1-flash` is not
 * `deepseek-v4-flash`, and the server answers 404 for a name it does not know.
 */
export const FREEPI_MODELS: readonly FreepiModelSpec[] = [
  { id: "particle", name: "Particle (free)", contextWindow: FREEPI_CONTEXT_WINDOW, maxTokens: FREEPI_MAX_TOKENS },
  { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash (free)", contextWindow: FREEPI_CONTEXT_WINDOW, maxTokens: FREEPI_MAX_TOKENS },
  { id: "glm-5.3-flash", name: "GLM 5.3 Flash (free)", contextWindow: FREEPI_CONTEXT_WINDOW, maxTokens: FREEPI_MAX_TOKENS },
  { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash (free)", contextWindow: FREEPI_CONTEXT_WINDOW, maxTokens: FREEPI_MAX_TOKENS },
];

/** True when `id` is one of the free models. */
export function isFreepiModel(id: string): boolean {
  return FREEPI_MODELS.some((model) => model.id === id);
}

/**
 * Is the active model a free-pi one?
 *
 * Both checks are needed: a provider id alone would be true for a model the
 * server added later, and an id alone would be true if another provider ever
 * used the same name.
 */
export function isFreepiActiveModel(provider: string | undefined, id: string | undefined): boolean {
  if (provider === FREEPI_PROVIDER_NAME) return true;
  return id !== undefined && isFreepiModel(id);
}

/** The four free models, in the order free-pi lists them. */
export const FREEPI_PROVIDER_MODELS: readonly FreepiCatalogModel[] = FREEPI_MODELS.map((model) => ({
  id: model.id,
  name: model.name,
  contextWindow: model.contextWindow,
  maxTokens: model.maxTokens,
}));

/** The model list in the shape `registerProvider` wants. */
export function freepiProviderModels(
  baseUrl: string = FREEPI_BASE_URL,
  models: readonly FreepiCatalogModel[] = FREEPI_MODELS,
): ProviderModelConfig[] {
  return models.map((model) => ({
    type: "chat",
    id: model.id,
    name: model.name,
    api: "openai-completions",
    baseUrl,
    input: ["text"],
    reasoning: false,
    // Free is free: a zero cost means /cost shows $0.00 for these on purpose,
    // instead of a guessed price that would be a lie in the other direction.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: model.contextWindow ?? FREEPI_CONTEXT_WINDOW,
    maxTokens: model.maxTokens ?? FREEPI_MAX_TOKENS,
  }));
}
