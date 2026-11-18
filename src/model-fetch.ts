// Fetch the model list from a user-supplied endpoint.
//
// Two questions make this less trivial than it looks:
//
// 1. **Which path?** A user pastes `https://api.openai.com` or
// `https://api.anthropic.com` or `https://openrouter.ai/api/v1`. Some serve
// `/models`, some `/v1/models`, some both, and an Anthropic-compatible base
// URL may not end in /v1 at all. Rather than guess, we try every sensible
// path in order and take the first that answers. A wrong path costs one
// request, not a failed setup.
//
// 2. **What shape is the reply?** OpenAI-compatible replies are
// `{ data: [{ id }] }`. Anthropic replies `{ data: [{ id, display_name }] }`
// at /v1/models. Some proxies return a bare array. All three are accepted;
// anything unrecognised is reported as "no model list" so the caller can ask
// for a model id by hand instead of showing an empty picker.
//
// Nothing here logs or returns the API key. It is used for the Authorization
// header and then dropped.

export interface ModelOption {
  id: string;
  name: string;
}

export interface FetchModelsResult {
  models: ModelOption[];
  /** The URL that answered, or undefined when every candidate failed. */
  source?: string;
  /**
   * Why no list came back, phrased for a human:
   * "auth" key rejected (401/403) — stop and fix the key
   * "unreachable" network/DNS/timeout — offer manual entry
   * "no-endpoint" answered, but no model list at that path
   */
  failure?: "auth" | "unreachable" | "no-endpoint";
  /** HTTP status when the endpoint answered. */
  status?: number;
}

export interface FetchModelsOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * Candidate URLs for a base URL, most specific first.
 *
 * A base URL that already ends in a version segment (`/v1`, `/v1beta`, `/api/v1`)
 * is tried as-is first, then with `/models` appended. A bare host gets `/v1/models`
 * before `/models` because the OpenAI convention leads.
 */
export function modelListCandidates(baseUrl: string): string[] {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (!trimmed) return [];

  const out: string[] = [];
  const hasVersion = /\/v\d+(beta\d*)?(\/|$)/i.test(trimmed);

  if (/\/models$/i.test(trimmed)) {
    out.push(trimmed);
  } else if (hasVersion) {
    out.push(`${trimmed}/models`);
  } else {
    out.push(`${trimmed}/v1/models`);
    out.push(`${trimmed}/models`);
  }

  // Dedupe while preserving order.
  return Array.from(new Set(out));
}

/** Normalise the several reply shapes into a model list. */
export function parseModelList(json: unknown): ModelOption[] {
  const container = json as { data?: unknown; models?: unknown } | null | undefined;
  const rows: unknown = Array.isArray(json) ? json : container?.data ?? container?.models;

  if (!Array.isArray(rows)) return [];

  const out: ModelOption[] = [];
  for (const row of rows) {
    if (typeof row === "string") {
      out.push({ id: row, name: row });
      continue;
    }
    if (!row || typeof row !== "object") continue;
    const obj = row as Record<string, unknown>;
    const id = typeof obj.id === "string" ? obj.id : typeof obj.model === "string" ? obj.model : undefined;
    if (!id) continue;
    const display =
      typeof obj.display_name === "string"
        ? obj.display_name
        : typeof obj.name === "string"
          ? obj.name
          : id;
    out.push({ id, name: display });
  }

  // Stable de-dupe by id; the same model can appear in both /models and /v1/models.
  const seen = new Set<string>();
  return out.filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)));
}

/**
 * Try each candidate path until one returns a usable model list.
 *
 * An auth failure short-circuits: if the key is wrong, every path will fail the
 * same way and retrying only wastes the user's time.
 */
export async function fetchModels(
  baseUrl: string,
  apiKey: string,
  opts: FetchModelsOptions = {},
): Promise<FetchModelsResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const candidates = modelListCandidates(baseUrl);

  if (candidates.length === 0) return { models: [], failure: "unreachable" };

  let lastStatus: number | undefined;
  let sawAnswer = false;

  for (const url of candidates) {
    try {
      const res = await doFetch(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          // Anthropic-style endpoints also accept this and some proxies require it.
          ...(apiKey ? { "x-api-key": apiKey } : {}),
        },
        signal: opts.signal ?? AbortSignal.timeout(timeoutMs),
      });

      lastStatus = res.status;

      if (res.status === 401 || res.status === 403) {
        // Wrong key: no other path will help.
        return { models: [], failure: "auth", status: res.status };
      }

      if (!res.ok) {
        sawAnswer = true;
        continue;
      }

      let json: unknown;
      try {
        json = await res.json();
      } catch {
        // A 200 with a non-JSON body means this path exists but is not a model
        // list (an HTML landing page, say). Keep looking.
        sawAnswer = true;
        continue;
      }

      const models = parseModelList(json);
      if (models.length > 0) return { models, source: url };

      sawAnswer = true;
    } catch {
      // Network error or timeout on this path; try the next candidate.
    }
  }

  return {
    models: [],
    failure: sawAnswer ? "no-endpoint" : "unreachable",
    status: lastStatus,
  };
}

/** One line explaining a failure, for the setup screen. */
export function describeFetchFailure(result: FetchModelsResult): string {
  switch (result.failure) {
    case "auth":
      return "That endpoint rejected the key (401/403). Check the key and try again.";
    case "unreachable":
      return "Couldn't reach that base URL. Check the spelling, or your connection.";
    case "no-endpoint":
      return "Connected, but this endpoint doesn't publish a model list. You can type the model name directly.";
    default:
      return "";
  }
}
