// free-pi's real model catalogue, cached on disk.
//
// The four free models were written down from the docs with a conservative
// context floor (128k / 16k out). That is honest but not true: the real numbers
// come from `GET /client-version`. So we ask once an hour, keep the answer in
// `~/.qronos/agent/freepi-models.json`, and fall back to the built-in four when
// there is no network or no file.
//
// Nothing here throws. A broken cache is the same as no cache: the CLI must
// always start.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { FREEPI_MODELS, FREEPI_ROOT_URL, FREEPI_PROVIDER_MODELS, type FreepiCatalogModel } from "./freepi-models";

/** One hour. A model list is not news; a request per launch is rude. */
export const CATALOG_TTL_MS = 60 * 60 * 1000;

export interface FreepiCatalogCache {
  version: 1;
  /** ISO time of the fetch that produced this list. */
  fetchedAt: string;
  models: FreepiCatalogModel[];
}

export type CatalogSource = "network" | "cache" | "builtin";

export interface FreepiCatalogResult {
  models: FreepiCatalogModel[];
  source: CatalogSource;
  /** Epoch ms of the fetch that produced the list; undefined for the built-in list. */
  fetchedAt?: number;
  /** Why the network was not used. For `qronos freepi status` and debug only. */
  note?: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function positive(value: unknown): number | undefined {
  const number = typeof value === "string" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) && number > 0 ? Math.round(number) : undefined;
}

function firstNumber(source: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = positive(source[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

const ID_KEYS = ["id", "model", "name", "slug"] as const;

/**
 * Emoji, arrows, dingbats and the invisible variation selectors.
 *
 * The live free-pi catalogue sends names like `Particle-1 · 🔥 Free Unlimited:
 * limited time`. That is a banner, not a model name.
 */
const NAME_NOISE = /[\u{1F000}-\u{1FAFF}\u{2190}-\u{2BFF}\u{FE00}-\u{FE0F}\u{200D}\u{2600}-\u{27BF}]/gu;
const NAME_MAX = 48;

/**
 * Turn a server display name into something a person can read in a list.
 *
 * Returns undefined when nothing useful is left, so the caller keeps our own
 * name instead of repeating the id.
 */
export function cleanModelName(raw: string | undefined, id: string): string | undefined {
  if (!raw) return undefined;
  // Everything after ` · ` is marketing: "Free Unlimited: limited time".
  const head = raw.split(" · ")[0] ?? raw;
  const plain = head.replace(NAME_NOISE, " ").replace(/\s+/g, " ").trim();
  if (plain === "" || plain.toLowerCase() === id.toLowerCase()) return undefined;
  return plain.length > NAME_MAX ? plain.slice(0, NAME_MAX).trim() : plain;
}
const CONTEXT_KEYS = ["context_window", "contextWindow", "context_length", "contextLength", "max_context_tokens"] as const;
const OUTPUT_KEYS = ["max_tokens", "maxTokens", "max_output_tokens", "maxOutputTokens"] as const;

/**
 * Read a model list out of whatever `/client-version` sent.
 *
 * Three shapes are accepted on purpose, because free-pi's exact envelope is
 * verified against the real service later: a flat array, `{ models: [...] }`,
 * and the OpenAI-style `{ data: [...] }`. An unknown shape gives an empty list,
 * which the caller reads as "use the built-in four".
 */
export function parseFreepiCatalog(payload: unknown): FreepiCatalogModel[] {
  if (Array.isArray(payload)) return rowsOf(payload);
  const outer = record(payload);
  if (!outer) return [];
  if (Array.isArray(outer.models)) return rowsOf(outer.models);
  if (Array.isArray(outer.data)) return rowsOf(outer.data);
  const nested = record(outer.models);
  if (nested && Array.isArray(nested.data)) return rowsOf(nested.data);
  return [];
}

function rowsOf(rows: unknown[]): FreepiCatalogModel[] {
  const models: FreepiCatalogModel[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (typeof row === "string") {
      const id = row.trim();
      if (id !== "" && !seen.has(id)) {
        seen.add(id);
        models.push({ id, name: id });
      }
      continue;
    }
    const source = record(row);
    if (!source) continue;
    const id = firstTextOf(source, ID_KEYS);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const contextWindow = firstNumber(source, CONTEXT_KEYS);
    const maxTokens = firstNumber(source, OUTPUT_KEYS);
    models.push({
      id,
      name:
        cleanModelName(text(source.display_name) ?? text(source.label), id) ??
        // The live catalogue puts the display name in `name`; `id` is separate.
        cleanModelName(text(source.name), id) ??
        id,
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(maxTokens !== undefined ? { maxTokens } : {}),
    });
  }
  return models;
}

function firstTextOf(source: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = text(source[key]);
    if (value) return value;
  }
  return undefined;
}

/**
 * Keep only the free models we know, in our order, with the server's numbers.
 *
 * Why filter: the catalogue may also list paid models on the same account, and
 * putting a paid model behind a free token would fail every call. The four free
 * ids are the contract; the catalogue only fills in their facts.
 */
export function mergeCatalog(builtin: readonly FreepiCatalogModel[], catalog: readonly FreepiCatalogModel[]): FreepiCatalogModel[] {
  const byId = new Map(catalog.map((model) => [model.id, model]));
  return builtin.map((model) => {
    const found = byId.get(model.id);
    if (!found) return model;
    return {
      id: model.id,
      // The server's display name is the real product name. When it only repeats
      // the id, or carries a marketing tail, our own name explains more.
      name: cleanModelName(found.name, model.id) ?? model.name,
      contextWindow: found.contextWindow ?? model.contextWindow,
      maxTokens: found.maxTokens ?? model.maxTokens,
    };
  });
}

export function readFreepiCatalogCache(path: string): FreepiCatalogCache | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    const outer = record(parsed);
    if (!outer || outer.version !== 1 || typeof outer.fetchedAt !== "string" || !Array.isArray(outer.models)) return undefined;
    const models = parseFreepiCatalog(outer.models);
    return models.length > 0 ? { version: 1, fetchedAt: outer.fetchedAt, models } : undefined;
  } catch {
    return undefined;
  }
}

export function writeFreepiCatalogCache(path: string, models: readonly FreepiCatalogModel[]): void {
  try {
    const body: FreepiCatalogCache = { version: 1, fetchedAt: new Date().toISOString(), models: [...models] };
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  } catch {
    // A cache that cannot be written is a slower start, not a failure.
  }
}

export interface LoadCatalogOptions {
  /** `~/.qronos/agent/freepi-models.json` */
  path: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  ttlMs?: number;
  /** Seam: reading the cache file. */
  read?: typeof readFreepiCatalogCache;
  /** Seam: writing the cache file. */
  write?: typeof writeFreepiCatalogCache;
}

/** The catalogue: fresh cache, then network, then the built-in four. */
export async function loadFreepiCatalog(options: LoadCatalogOptions): Promise<FreepiCatalogResult> {
  const now = options.now ?? Date.now;
  const ttl = options.ttlMs ?? CATALOG_TTL_MS;
  const read = options.read ?? readFreepiCatalogCache;
  const write = options.write ?? writeFreepiCatalogCache;

  const cached = read(options.path);
  if (cached) {
    const age = now() - Date.parse(cached.fetchedAt);
    if (Number.isFinite(age) && age >= 0 && age < ttl) {
      return { models: mergeCatalog(FREEPI_PROVIDER_MODELS, cached.models), source: "cache", fetchedAt: Date.parse(cached.fetchedAt) };
    }
  }

  try {
    const doFetch = options.fetchImpl ?? fetch;
    const response = await doFetch(`${options.baseUrl ?? FREEPI_ROOT_URL}/client-version`, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(3_000),
    });
    if (response.ok) {
      const parsed = parseFreepiCatalog(await response.json());
      if (parsed.length > 0) {
        // Only the four free rows are kept: the catalogue may also list paid
        // models, and a cache has no business remembering those.
        const free = mergeCatalog(FREEPI_PROVIDER_MODELS, parsed);
        write(options.path, free);
        return { models: free, source: "network", fetchedAt: now() };
      }
      return fallback(cached, "the catalogue had no usable models");
    }
    return fallback(cached, `http ${response.status}`);
  } catch (error) {
    return fallback(cached, `fetch failed: ${(error as Error).message}`);
  }
}

function fallback(cached: FreepiCatalogCache | undefined, note: string): FreepiCatalogResult {
  if (cached) {
    return {
      models: mergeCatalog(FREEPI_PROVIDER_MODELS, cached.models),
      source: "cache",
      fetchedAt: Date.parse(cached.fetchedAt),
      note,
    };
  }
  return { models: mergeCatalog(FREEPI_PROVIDER_MODELS, []), source: "builtin", note };
}

/** One line for `qronos freepi status`. */
export function catalogSourceText(result: FreepiCatalogResult, now = Date.now()): string {
  if (result.source === "builtin") {
    return `models: built-in four (${result.note ?? "no catalogue yet"})`;
  }
  const ageMinutes = result.fetchedAt === undefined ? undefined : Math.max(0, Math.round((now - result.fetchedAt) / 60_000));
  const age = ageMinutes === undefined ? "age unknown" : `age ${ageMinutes}m`;
  return `models: from ${result.source === "network" ? "the server" : "cache"} (${age})`;
}

/** The built-in four, for callers that need the ids without touching disk. */
export const FREEPI_FALLBACK_IDS = FREEPI_MODELS.map((model) => model.id);
