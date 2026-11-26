import type { ScopedModel } from "@earendil-works/pi-coding-agent";
import { FUSION_PICKER_ID } from "./fusion";

// Model-picker lock. pi shows every provider whose auth is configured — and it
// auto-discovers a *builtin* provider (openrouter, huggingface, openai,
// amazon-bedrock, google-vertex, …) for any matching credential in the
// environment. Picking one silently routes around qronos (their key, their
// bill, no free model). Those providers are pi builtins, so they can't be
// unregistered; and their credentials are often dual-use (AWS/gcloud creds the
// agent's `bash` tool legitimately needs), so we won't delete env vars either.
//
// Instead we use pi's own model-scope: when a session's `scopedModels` is
// non-empty, the model picker, `/model`, and model-cycling show ONLY those
// models and ignore provider availability entirely (interactive-mode.js:449).
// It reads no env vars, so every credential stays intact for `bash`.
//
// QRONOS_KEEP_ENV_PROVIDERS=1 opts out — an empty scope means "show everything",
// so the user's own env/`/login` providers appear as before.

/** A provider we do want in the picker, besides the qronos gateway. */
export interface ScopeExtra {
  provider: string;
  ids: readonly string[];
}

/** Minimal slice of ModelRuntime this needs — kept narrow so it's trivially testable. */
interface ModelFinder {
  getModel(provider: string, modelId: string): ScopedModel["model"] | undefined;
}

/**
 * The `scopedModels` to hand `createAgentSessionFromServices`: only the qronos
 * catalog models and Fusion (listed first), so the picker shows nothing the
 * user's env leaks. Empty (no scope → every provider shows) when
 * QRONOS_KEEP_ENV_PROVIDERS is set, or if none of the ids are registered yet
 * (fail open rather than a picker with zero models).
 */
export function resolveQronosScope(
  modelRuntime: ModelFinder,
  providerName: string,
  modelIds: string[],
  env: Record<string, string | undefined> = process.env,
  extras: readonly ScopeExtra[] = [],
): ScopedModel[] {
  if (env.QRONOS_KEEP_ENV_PROVIDERS) return [];
  const scoped: ScopedModel[] = [];
  for (const id of new Set([FUSION_PICKER_ID, ...modelIds])) {
    const model = modelRuntime.getModel(providerName, id);
    if (model) scoped.push({ model });
  }
  // A provider whose credentials we own (the free pool) goes after the
  // gateway models. Without this the lock hides the four free models, and
  // `/model free/particle` answers "no model found".
  for (const extra of extras) {
    for (const id of extra.ids) {
      const model = modelRuntime.getModel(extra.provider, id);
      const already = scoped.some((entry) => entry.model.provider === extra.provider && entry.model.id === id);
      if (model && !already) scoped.push({ model });
    }
  }
  return scoped;
}
