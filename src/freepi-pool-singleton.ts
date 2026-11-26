// One pool per process, filled from the shared pool in the qronos-ai admin panel.
//
// Why a singleton: a model request and an ad request are both requests against
// the same free-pi limit. If the provider and the ad code each built their own
// pool, both could hand out the same token at the same moment — which is
// exactly the concurrency rule we promised to respect.
//
// One source only: `GET /api/cli/freepi/tokens` on the qronos gateway.
//
// There is no fallback on purpose. A local file or an environment variable would
// quietly hide a broken shared pool, and the whole point of the pool is that one
// signed-in user gets the same tokens on every machine. A failed read is an empty
// pool: the CLI still starts, `/model` simply shows no free-pi model, and
// `qronos-cli freepi status` says why.
import { FreepiTokenPool } from "./freepi-tokens";
import type { FreepiTokenRecord } from "./freepi-tokens";

export interface LoadPoolOptions {
  /** The key the pool is read with. No key means no pool. */
  path?: string;
  now?: () => number;
  /** Seam: reading a saved file. Only kept so old call sites keep working. */
  read?: unknown;
  /** Seam: the environment. No longer a token source. */
  env?: Record<string, string | undefined>;
  /** The shared pool. A failure here is an empty pool, never a broken start. */
  remote?: () => Promise<readonly FreepiTokenRecord[]>;
}

/** Where the tokens came from, for `freepi status` and the debug line. */
export type PoolSource = "server" | "none";

const pools = new Map<string, Promise<FreepiTokenPool>>();
const lastSource = new Map<string, PoolSource>();

/** The pool for this key, built once and shared. */
export function loadFreepiPool(options: LoadPoolOptions): Promise<FreepiTokenPool> {
  const cacheKey = options.path ?? "server";
  const existing = pools.get(cacheKey);
  if (existing) return existing;
  const created = resolveRecords(options).then(
    (records) => new FreepiTokenPool(records, { now: options.now }),
  );
  pools.set(cacheKey, created);
  return created;
}

/**
 * Which tokens the shared pool gives us.
 *
 * A read that fails, or answers with nothing, is an empty pool. It is never an
 * error the caller has to handle: the CLI must always start.
 */
export async function resolveRecords(
  options: Pick<LoadPoolOptions, "path" | "env" | "remote">,
): Promise<FreepiTokenRecord[]> {
  const cacheKey = options.path ?? "server";
  if (!options.remote) {
    lastSource.set(cacheKey, "none");
    return [];
  }
  try {
    const remote = await options.remote();
    if (remote.length > 0) {
      lastSource.set(cacheKey, "server");
      return [...remote];
    }
    lastSource.set(cacheKey, "none");
    return [];
  } catch {
    lastSource.set(cacheKey, "none");
    return [];
  }
}

/** Which source the last read used. Display only; it never changes a decision. */
export function freepiPoolSource(path?: string): PoolSource {
  return lastSource.get(path ?? "server") ?? "none";
}

/** Forget the cached pool. For tests, and after a login fills a slot. */
export function resetFreepiPools(): void {
  pools.clear();
  lastSource.clear();
}
