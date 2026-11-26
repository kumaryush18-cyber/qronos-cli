// The free-pi token pool: many keys, one request at a time per key.
//
// Why a pool at all: free-pi allows about 1–2 requests at once, and its rule is
// one live session per token. So a token is either *free* or *in use*, and a
// request that finds every token in use must WAIT — not hammer a busy key and
// not fail.
//
// Three rules this file keeps:
//   1. One request per token at a time. A busy token is never handed a second.
//   2. One session id per token, made once and kept. Rotating an id looks like a
//      new session and breaks free-pi's own accounting.
//   3. A 429 (or 402/403) puts that token in a cool-down and the next request
//      goes to a different token. A cool-down grows while failures repeat and
//      resets after one success.
//
// No network, no files, no clock of its own: `now` and `sleep` are seams, so a
// test needs no waiting and the pool stays readable.
import { randomUUID } from "node:crypto";

export interface FreepiTokenRecord {
  /** A short local id, e.g. `t1`. Never the secret. */
  id: string;
  token: string;
  label?: string;
  /** One id per token, reused for every request that token makes. */
  sessionId: string;
  addedAt?: string;
  /** Epoch ms. 0 or missing means "fine to use". */
  coolDownUntil?: number;
  /** Consecutive failures, so a cool-down can grow. */
  failures?: number;
}

export interface TokenLease {
  tokenId: string;
  token: string;
  sessionId: string;
}

export interface PoolOptions {
  now?: () => number;
  /** First cool-down after a 429. Doubles per failure, up to `maxCoolDownMs`. */
  coolDownMs?: number;
  maxCoolDownMs?: number;
  /** Injected in tests: resolves after `ms`. */
  sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_COOL_DOWN_MS = 60_000;
export const MAX_COOL_DOWN_MS = 15 * 60_000;
/** How often a waiting request looks for a free token. */
export const POOL_POLL_MS = 500;

/** A token safe to print: enough to recognise it, never enough to use it. */
export function maskToken(token: string): string {
  if (token.length <= 8) return "*".repeat(Math.max(4, token.length));
  return `${token.slice(0, 4)}…${token.slice(-4)}`;
}

/** HTTP statuses that mean "this token, not now" rather than "this request is wrong". */
export function isCoolDownStatus(status: number | undefined): boolean {
  return status === 429 || status === 402 || status === 403;
}

export class FreepiTokenPool {
  private readonly records: FreepiTokenRecord[];
  private readonly busy = new Set<string>();
  private readonly options: Required<PoolOptions>;
  private cursor = 0;

  constructor(records: readonly FreepiTokenRecord[], options: PoolOptions = {}) {
    this.records = records.map((record) => ({ ...record }));
    this.options = {
      now: options.now ?? (() => Date.now()),
      coolDownMs: options.coolDownMs ?? DEFAULT_COOL_DOWN_MS,
      maxCoolDownMs: options.maxCoolDownMs ?? MAX_COOL_DOWN_MS,
      sleep: options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
    };
  }

  get size(): number {
    return this.records.length;
  }

  get busyCount(): number {
    return this.busy.size;
  }

  /** The records, for `/freepi list`. Copies, so a caller cannot edit the pool. */
  snapshot(): Array<{ id: string; label: string; masked: string; busy: boolean; coolDownSeconds: number }> {
    const now = this.options.now();
    return this.records.map((record) => ({
      id: record.id,
      label: record.label ?? record.id,
      masked: maskToken(record.token),
      busy: this.busy.has(record.id),
      coolDownSeconds: Math.max(0, Math.ceil(((record.coolDownUntil ?? 0) - now) / 1000)),
    }));
  }

  /** True while at least one token could take a request right now. */
  hasFreeToken(): boolean {
    const now = this.options.now();
    return this.records.some((record) => !this.busy.has(record.id) && (record.coolDownUntil ?? 0) <= now);
  }

  /**
   * Take a free token, round-robin, and mark it busy.
   *
   * Undefined means "every token is busy or cooling down" — the caller waits,
   * because a second request on a busy key is exactly what free-pi forbids.
   */
  acquire(): TokenLease | undefined {
    if (this.records.length === 0) return undefined;
    const now = this.options.now();
    for (let step = 0; step < this.records.length; step += 1) {
      const index = (this.cursor + step) % this.records.length;
      const record = this.records[index]!;
      if (this.busy.has(record.id)) continue;
      if ((record.coolDownUntil ?? 0) > now) continue;
      this.busy.add(record.id);
      this.cursor = (index + 1) % this.records.length;
      return { tokenId: record.id, token: record.token, sessionId: record.sessionId };
    }
    return undefined;
  }

  /**
   * Wait for a token, up to `timeoutMs`.
   *
   * Waiting is the honest answer here: free-pi's own limit is one request at a
   * time per token, so a queue of requests is the only thing that respects it.
   */
  async waitForFree(timeoutMs: number): Promise<TokenLease | undefined> {
    const deadline = this.options.now() + Math.max(0, timeoutMs);
    for (;;) {
      const lease = this.acquire();
      if (lease) return lease;
      if (this.options.now() >= deadline) return undefined;
      await this.options.sleep(Math.min(POOL_POLL_MS, Math.max(1, deadline - this.options.now())));
    }
  }

  /**
   * Give the token back.
   *
   * A cool-down status parks that token for a while and grows the wait if the
   * same token keeps failing. Any other answer (success, 400, 500) frees it at
   * once, because a bad request is not the token's fault.
   */
  release(tokenId: string, result: { status?: number; ok?: boolean } = {}): void {
    this.busy.delete(tokenId);
    const record = this.records.find((item) => item.id === tokenId);
    if (!record) return;
    if (!isCoolDownStatus(result.status)) {
      record.failures = 0;
      record.coolDownUntil = 0;
      return;
    }
    const failures = (record.failures ?? 0) + 1;
    record.failures = failures;
    const wait = Math.min(this.options.coolDownMs * 2 ** (failures - 1), this.options.maxCoolDownMs);
    record.coolDownUntil = this.options.now() + wait;
  }

  /** The records with their cool-down state, ready to be written back to disk. */
  exportRecords(): FreepiTokenRecord[] {
    return this.records.map((record) => ({ ...record }));
  }
}

/** A fresh local id that does not collide with the ones already saved. */
export function nextTokenId(records: readonly FreepiTokenRecord[]): string {
  for (let index = 1; index < 10_000; index += 1) {
    const id = `t${index}`;
    if (!records.some((record) => record.id === id)) return id;
  }
  return `t-${randomUUID().slice(0, 8)}`;
}

/** A new record for a pasted token: one session id, made now and kept. */
export function makeTokenRecord(token: string, records: readonly FreepiTokenRecord[], label?: string): FreepiTokenRecord {
  return {
    id: nextTokenId(records),
    token: token.trim(),
    ...(label && label.trim() !== "" ? { label: label.trim() } : {}),
    sessionId: randomUUID(),
    addedAt: new Date().toISOString(),
    coolDownUntil: 0,
    failures: 0,
  };
}
