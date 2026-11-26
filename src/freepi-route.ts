// What one free-model request actually did, reported for the admin panel.
//
// The panel needs to answer "which key served this, how long did it take, and
// how many tokens did it really cost". None of that comes from the gateway: the
// request goes straight from this machine to the upstream service. So the CLI
// sends one small event per attempt.
//
// Rules:
//  - nothing is printed: this is telemetry, not output;
//  - no token, no prompt, no answer ever leaves the machine — only a slot id,
//    a model id, a status, a duration and two token counts;
//  - a missing number is `null`, never a zero;
//  - a reporting failure is silent. A live answer must never die because a
//    report failed.
import { reportAuthToken, reportOrigin, telemetryEnabled } from "./client-report";

const ROUTE_PATH = "/api/cli/freepi/routing";
const TIMEOUT_MS = 4000;

export interface FreepiRouteEvent {
  /** The pool record id, such as `srv-2`. Never a token. */
  key: string;
  /** The slot number when the id tells us one, else null. */
  slot: number | null;
  model: string;
  status: number;
  ms: number;
  inputTokens: number | null;
  outputTokens: number | null;
}

/** `srv-2` is slot 1, because slots count from zero and ids count from one. */
export function slotFromKey(key: string | undefined | null): number | null {
  if (!key) return null;
  const match = /^srv-(\d+)$/.exec(key.trim());
  if (!match) return null;
  const oneBased = Number(match[1]);
  return Number.isInteger(oneBased) && oneBased > 0 ? oneBased - 1 : null;
}

const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;

/**
 * The two token counts from a finished answer.
 *
 * pi reports them on `message.usage`, with `input` as the prompt and `output` as
 * the completion (reasoning tokens are a part of output, so they are not added).
 */
export function readUsageTokens(message: unknown): { inputTokens: number | null; outputTokens: number | null } {
  const usage = (message as { usage?: { input?: unknown; output?: unknown } } | undefined)?.usage;
  return { inputTokens: count(usage?.input), outputTokens: count(usage?.output) };
}

/** One event, from what we know at the end of an attempt. Never throws. */
export function buildRouteEvent(input: {
  key: string;
  model: string;
  status: number | undefined;
  startedAt: number;
  finishedAt: number;
  message?: unknown;
}): FreepiRouteEvent {
  const { inputTokens, outputTokens } = readUsageTokens(input.message);
  const ms = Math.max(0, Math.round(input.finishedAt - input.startedAt));
  return {
    key: input.key,
    slot: slotFromKey(input.key),
    model: input.model,
    status: typeof input.status === "number" ? input.status : 0,
    ms,
    inputTokens,
    outputTokens,
  };
}

export interface RouteReportDeps {
  fetchImpl?: typeof fetch;
  authToken?: () => Promise<string | undefined>;
  origin?: string;
  enabled?: () => boolean;
}

/**
 * Send one event. Resolves to whether the gateway accepted it.
 *
 * Never throws, never retries, never waits longer than four seconds: the tool
 * loop must not notice this call happened.
 */
export async function postRouteEvent(event: FreepiRouteEvent, deps: RouteReportDeps = {}): Promise<boolean> {
  const allowed = deps.enabled ?? telemetryEnabled;
  if (!allowed()) return false;
  try {
    const token = await (deps.authToken ?? reportAuthToken)();
    if (!token) return false;
    const origin = deps.origin ?? reportOrigin();
    const doFetch = deps.fetchImpl ?? fetch;
    const response = await doFetch(`${origin}${ROUTE_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "x-qronos-client": "cli",
      },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** Send one event and forget about it. The caller never waits. */
export function reportRouteEvent(event: FreepiRouteEvent, deps?: RouteReportDeps): void {
  void postRouteEvent(event, deps).catch(() => undefined);
}
