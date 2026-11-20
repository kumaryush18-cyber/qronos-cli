// Retry policy for every model request we control.
//
// Why this exists: a single "model temporarily unavailable" used to kill a
// subagent at once. Claude Code retries transient failures up to ten times with
// growing delays; this module does the same, with our own schedule
// (10 s, 30 s, then 60 s each) and a rule that matters more than the numbers:
// **never retry after work was done**. A retried turn must be a turn that
// produced nothing, otherwise a tool could run twice.
//
// The classifier is pi's (`isRetryableAssistantError`), widened with the wording
// our own gateway uses, so the main chat and our subagents agree.

import { isRetryableAssistantError } from "@earendil-works/pi-ai/compat";

export interface RetryPolicy {
  enabled: boolean;
  /** Retries after the first try. 10 means up to 11 requests. */
  maxRetries: number;
  /** Delay per retry, in ms. The last value repeats. */
  scheduleMs: number[];
  /** Hard cap for one wait, even if a server asks for longer. */
  maxWaitMs: number;
}

export const DEFAULT_MAX_RETRIES = 10;
export const DEFAULT_RETRY_SCHEDULE_MS = [10_000, 30_000, 60_000];
export const DEFAULT_MAX_WAIT_MS = 60_000;
export const MAX_RETRIES_ALLOWED = 15;

/** Wording our gateway uses that pi's list does not cover. */
const EXTRA_RETRYABLE = [
  /temporarily unavailable/i,
  /model is (?:not|un)available/i,
  /no available (?:channel|model)/i,
  /\b529\b/,
  /bad gateway/i,
  /gateway time-?out/i,
  /please (?:retry|try again)/i,
  /try again (?:later|shortly)/i,
  /upstream (?:error|failure)/i,
];

/**
 * Errors that must never be retried, even if the wording also looks transient.
 * Retrying a billing or auth failure only wastes minutes and hides the cause.
 */
const NEVER_RETRY = [
  /balance is exhausted/i,
  /token plan/i,
  /insufficient (?:quota|balance|funds)/i,
  /quota exceeded/i,
  /out of budget/i,
  /spend(?:ing)? limit/i,
  /unauthorized/i,
  /invalid (?:api )?key/i,
  /\b401\b/,
  /\b402\b/,
  /\b403\b/,
  /certificate/i,
  /self[ -]signed certificate/i,
  /content (?:policy|filter)/i,
];

export type ErrorVerdict = "retry" | "stop";

/** Should this error text be retried? */
export function classifyError(message: string | undefined): ErrorVerdict {
  const text = (message ?? "").trim();
  // An unknown failure is treated as permanent. Claude Code does the same:
  // retrying a reason nobody recognises mostly wastes minutes and hides the
  // cause. Wording we know to be transient is listed in EXTRA_RETRYABLE below.
  for (const pattern of NEVER_RETRY) {
    if (pattern.test(text)) return "stop";
  }
  for (const pattern of EXTRA_RETRYABLE) {
    if (pattern.test(text)) return "retry";
  }
  // pi's classifier wants an assistant-shaped message; give it the two fields it reads.
  const retryable = isRetryableAssistantError({ stopReason: "error", errorMessage: text } as any);
  return retryable ? "retry" : "stop";
}

/** Delay before retry number `attempt` (1-based). */
export function retryDelayMs(policy: Pick<RetryPolicy, "scheduleMs" | "maxWaitMs">, attempt: number): number {
  const schedule = policy.scheduleMs.length > 0 ? policy.scheduleMs : DEFAULT_RETRY_SCHEDULE_MS;
  const index = Math.min(Math.max(0, attempt - 1), schedule.length - 1);
  const delay = schedule[index] ?? DEFAULT_RETRY_SCHEDULE_MS[0]!;
  return Math.max(0, Math.min(delay, policy.maxWaitMs));
}

function parseSchedule(value: string | undefined): number[] {
  if (!value) return DEFAULT_RETRY_SCHEDULE_MS;
  const seconds = value
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((n) => Number.isFinite(n) && n >= 0);
  if (seconds.length === 0) return DEFAULT_RETRY_SCHEDULE_MS;
  return seconds.map((n) => Math.round(n * 1000));
}

function parseNumber(value: string | undefined, fallback: number): number {
  const text = (value ?? "").trim();
  if (text === "") return fallback;
  const n = Number(text);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Read the policy from the environment.
 *   QRONOS_RETRY=0            turn retries off
 *   QRONOS_MAX_RETRIES=n      default 10, capped at 15
 *   QRONOS_RETRY_SCHEDULE=10,30,60   seconds
 *   QRONOS_RETRY_MAX_WAIT_MS=60000
 */
export function retryPolicyFromEnv(env: Record<string, string | undefined> = process.env): RetryPolicy {
  const enabled = (env.QRONOS_RETRY ?? "1").trim() !== "0";
  const retries = Math.round(parseNumber(env.QRONOS_MAX_RETRIES, DEFAULT_MAX_RETRIES));
  return {
    enabled,
    maxRetries: Math.max(0, Math.min(retries, MAX_RETRIES_ALLOWED)),
    scheduleMs: parseSchedule(env.QRONOS_RETRY_SCHEDULE),
    maxWaitMs: Math.max(0, parseNumber(env.QRONOS_RETRY_MAX_WAIT_MS, DEFAULT_MAX_WAIT_MS)),
  };
}

export type RetryOutcome<T> =
  | { ok: true; value: T; attempts: number }
  | { ok: false; error: string; attempts: number; aborted: boolean };

export interface RetryInfo {
  /** 1-based retry number. */
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  error: string;
}

export interface WithRetryOptions<T> {
  policy?: RetryPolicy;
  signal?: AbortSignal;
  /** Turn a successful-looking result into an error string when it is really a failure. */
  failureOf?: (value: T) => string | undefined;
  /** Called before each wait, for the "Retrying in 10s" line. */
  onRetry?: (info: RetryInfo) => void;
  /** Called after each wait, before the next request starts. */
  onAttemptStart?: (attempt: number) => void;
  /** Test seam. Returns false when the wait was aborted. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<boolean>;
  /** Test seam. */
  classify?: (message: string | undefined) => ErrorVerdict;
  /**
   * Last word on whether this failure may be retried. The caller uses it to say
   * "no": once text or a tool call has been produced, sending the request again
   * could repeat a side effect, so the failure must surface instead.
   */
  canRetry?: () => boolean;
}

/** Sleep that can be interrupted. Resolves false when aborted. */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      resolve(false);
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Run `run` until it succeeds, fails for a reason worth retrying, or runs out of
 * attempts. Nothing here decides *when* a retry is safe from the caller's point
 * of view — the caller only passes operations that have not committed anything.
 */
export async function withRetry<T>(
  run: () => Promise<T>,
  options: WithRetryOptions<T> = {},
): Promise<RetryOutcome<T>> {
  const policy = options.policy ?? retryPolicyFromEnv();
  const classify = options.classify ?? classifyError;
  const sleep = options.sleep ?? abortableSleep;
  const maxAttempts = policy.enabled ? policy.maxRetries + 1 : 1;

  let attempts = 0;
  let lastError = "";

  for (;;) {
    if (options.signal?.aborted) {
      return { ok: false, error: lastError || "aborted", attempts, aborted: true };
    }
    attempts++;

    let value: T | undefined;
    let error: string | undefined;
    try {
      value = await run();
      error = options.failureOf?.(value);
    } catch (err: any) {
      error = err?.message ?? String(err ?? "unknown error");
    }

    if (error === undefined) {
      return { ok: true, value: value as T, attempts };
    }
    lastError = error;

    if (attempts >= maxAttempts) {
      return { ok: false, error: lastError, attempts, aborted: false };
    }
    if (classify(lastError) === "stop") {
      return { ok: false, error: lastError, attempts, aborted: false };
    }
    if (options.canRetry && !options.canRetry()) {
      return { ok: false, error: lastError, attempts, aborted: false };
    }

    const delayMs = retryDelayMs(policy, attempts);
    options.onRetry?.({ attempt: attempts, maxAttempts: policy.maxRetries, delayMs, error: lastError });
    const slept = await sleep(delayMs, options.signal);
    if (!slept) {
      return { ok: false, error: lastError, attempts, aborted: true };
    }
    options.onAttemptStart?.(attempts + 1);
  }
}

/** The one-line notice shown while a request is waiting to be retried. */
export function formatRetryLine(info: RetryInfo): string {
  const seconds = Math.round(info.delayMs / 1000);
  return `Retrying in ${seconds}s · attempt ${info.attempt}/${info.maxAttempts} — ${firstLine(info.error)}`;
}

function firstLine(text: string): string {
  const line = text.split("\n")[0] ?? text;
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}
