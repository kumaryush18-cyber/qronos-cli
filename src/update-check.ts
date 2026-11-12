// Startup version & live model catalog check.
// Connects to Qronos AI /v1/models to fetch live frontier models.
import { ClientVersionResponseSchema, compareVersions } from "@qronos/shared";

export interface ClientVersionCheck {
  action: "block" | "notice" | "ok";
  latest?: string;
  /** Server-reported active model to display. */
  model?: string;
  /** Selectable model catalog (id = request model, name = label). */
  models?: Array<{ id: string; name: string }>;
  /** Optional one-line startup notice. */
  notice?: string;
  /** Server-chosen Fusion planner/executor catalog ids. */
  fusion?: { planner: string; executor: string };
}

export async function checkClientVersion(
  baseUrl: string,
  cliVersion: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ClientVersionCheck> {
  const result: ClientVersionCheck = { action: "ok" };

  // 1. Fetch live models catalog from /v1/models
  try {
    const modelsUrl = new URL("/v1/models", baseUrl);
    const mRes = await fetchImpl(modelsUrl, {
      signal: AbortSignal.timeout(3_000),
      headers: { "Accept": "application/json" },
    });
    if (mRes.ok) {
      const json = await mRes.json() as any;
      const list = json?.data;
      if (Array.isArray(list) && list.length > 0) {
        result.models = list.map((m: any) => ({
          id: m.id,
          name: m.display_name || m.name || m.id,
        }));
        // Select preferred default model: Claude Sonnet 5.5, Claude Opus 5.5, or DeepSeek
        const preferred =
          result.models.find((m) => m.id === "claude-sonnet-5.5") ||
          result.models.find((m) => m.id.includes("sonnet")) ||
          result.models.find((m) => m.id === "deepseek-v4-flash") ||
          result.models[0];
        result.model = preferred?.id;
      }
    }
  } catch {
    // Offline or network error: continue with built-in catalog
  }

  // 2. Check /client-version if supported
  try {
    const res = await fetchImpl(new URL("/client-version", baseUrl), {
      signal: AbortSignal.timeout(3_000),
    });
    if (res.ok) {
      const parsed = ClientVersionResponseSchema.safeParse(await res.json());
      if (parsed.success) {
        const { min, latest, model, models, notice, fusion } = parsed.data;
        if (model) result.model = model;
        if (models && models.length > 0) result.models = models;
        if (notice) result.notice = notice;
        if (fusion) result.fusion = fusion;

        if (compareVersions(cliVersion, min) === -1) result.action = "block";
        else if (compareVersions(cliVersion, latest) === -1) result.action = "notice";
        if (latest) result.latest = latest;
      }
    }
  } catch {
    // Keep action: "ok"
  }

  return result;
}
