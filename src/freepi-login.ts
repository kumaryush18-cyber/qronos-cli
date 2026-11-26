// `qronos freepi login`: one command, browser, done — the same public sign-in
// endpoints free-pi's own client uses. Nothing is copied out of another app's
// storage, and nothing signs anyone out.
//
// The flow (verified against the installed free-pi client):
//   1. POST /auth/github/device  → a user code and a URL to open
//   2. the user approves in the browser
//   3. POST /auth/token          → { status: "pending" } until it becomes
//                                   { token: "…" }
//   4. free-pi requires consent before it issues a token: on
//      `consent_required` the user is shown the same sentences free-pi shows
//      and must answer yes. Declining saves nothing.
//
// Rules kept here:
//   - the token is never printed, only masked, and only after saving;
//   - a poll runs at the server's own interval, and stops at its deadline;
//   - every failure has a plain sentence, no stack trace, no secret.
import type { ClientIdentity } from "./ad-client-headers";
import { clientHeaders } from "./ad-client-headers";

/** free-pi's own consent version. Bumped by them, not by us. */
export const FREEPI_CONSENT_VERSION = "4";

/** The words free-pi shows before it issues a token. Shown, never paraphrased. */
export const FREEPI_CONSENT_TEXT = [
  "free-pi is free. In exchange, we show you ads and may train on your data.",
  "If you want to use free-pi, you accept that. If you don't, don't use it.",
  "You must be at least 13 in the US, 16 in the EEA/UK, or 18 elsewhere.",
  "Terms: https://freepi.ai/terms   Privacy: https://freepi.ai/privacy",
].join("\n");

/** How long a login may take before it gives up. */
export const LOGIN_DEADLINE_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;
const MIN_INTERVAL_SECONDS = 2;
const MAX_INTERVAL_SECONDS = 30;

export interface DeviceStart {
  sessionId: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  intervalSeconds: number;
  expiresInSeconds?: number;
}

export type TokenPoll =
  | { status: "pending"; retryAfterSeconds?: number }
  | { status: "issued"; token: string }
  | { status: "consent"; message: string };

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Read the device-code answer. An unknown shape is `undefined`, never a crash. */
export function parseDeviceStart(payload: unknown): DeviceStart | undefined {
  const outer = record(payload);
  if (!outer) return undefined;
  const sessionId = text(outer.session_id);
  const userCode = text(outer.user_code);
  const verificationUri = text(outer.verification_uri);
  if (!sessionId || !userCode || !verificationUri) return undefined;
  const interval = positiveNumber(outer.interval) ?? MIN_INTERVAL_SECONDS;
  const expiresIn = positiveNumber(outer.expires_in);
  return {
    sessionId,
    userCode,
    verificationUri,
    ...(text(outer.verification_uri_complete) ? { verificationUriComplete: text(outer.verification_uri_complete)! } : {}),
    // Clamped: a server asking for a 1-second poll would hammer it.
    intervalSeconds: Math.min(MAX_INTERVAL_SECONDS, Math.max(MIN_INTERVAL_SECONDS, interval)),
    ...(expiresIn ? { expiresInSeconds: expiresIn } : {}),
  };
}

/** Read one `/auth/token` answer. */
export function parseTokenPoll(payload: unknown, httpStatus = 200): TokenPoll {
  const outer = record(payload);
  if (httpStatus === 403 && outer?.code === "consent_required") {
    return { status: "consent", message: text(outer.message) ?? "free-pi needs your consent first." };
  }
  const token = text(outer?.token);
  if (token) return { status: "issued", token };
  if (outer?.code === "consent_required") {
    return { status: "consent", message: text(outer.message) ?? "free-pi needs your consent first." };
  }
  return { status: "pending", ...(positiveNumber(outer?.retry_after) ? { retryAfterSeconds: positiveNumber(outer?.retry_after)! } : {}) };
}

async function postJson(
  url: string,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  return fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", ...extraHeaders },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

export async function startDeviceLogin(baseUrl: string, fetchImpl: typeof fetch, identity?: ClientIdentity): Promise<DeviceStart> {
  const response = await postJson(`${baseUrl}/auth/github/device`, {}, fetchImpl, identity ? clientHeaders(identity) : {});
  if (!response.ok) throw new Error(`free-pi refused to start sign-in (HTTP ${response.status}).`);
  const start = parseDeviceStart(await response.json().catch(() => undefined));
  if (!start) throw new Error("free-pi sent a sign-in answer we could not read.");
  return start;
}

export async function pollForToken(baseUrl: string, sessionId: string, fetchImpl: typeof fetch, identity?: ClientIdentity): Promise<TokenPoll> {
  try {
    const response = await postJson(
      `${baseUrl}/auth/token`,
      { session_id: sessionId, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
      fetchImpl,
      identity ? clientHeaders(identity) : {},
    );
    const payload = await response.json().catch(() => undefined);
    if (response.status === 204) return { status: "pending" };
    return parseTokenPoll(payload, response.status);
  } catch {
    // A network blip during sign-in is not a failure; the next poll may work.
    return { status: "pending" };
  }
}

export async function acceptConsent(
  baseUrl: string,
  sessionId: string,
  fetchImpl: typeof fetch,
  attribution: { signupSrc?: string; referralCode?: string } = {},
): Promise<boolean> {
  try {
    const response = await postJson(
      `${baseUrl}/auth/consent`,
      {
        session_id: sessionId,
        consent_version: FREEPI_CONSENT_VERSION,
        ...(attribution.signupSrc ? { signup_src: attribution.signupSrc } : {}),
        ...(attribution.referralCode ? { referral_code: attribution.referralCode } : {}),
      },
      fetchImpl,
    );
    return response.ok;
  } catch {
    return false;
  }
}

export interface LoginDeps {
  baseUrl: string;
  /** Opens the browser; a failure here only means the URL is printed instead. */
  open: (url: string) => void;
  log: (line: string) => void;
  /** Asks the consent question. Returns true only for a clear yes. */
  confirm: (question: string) => Promise<boolean>;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  deadlineMs?: number;
  identity?: ClientIdentity;
  /** `https://freepi.ai/?ref=…` — shown to a new user, never required. */
  inviteUrl?: string;
  /** Sent with the consent, so a new account is attributed correctly. */
  attribution?: { signupSrc?: string; referralCode?: string };
}

export type LoginResult = { ok: true; token: string } | { ok: false; reason: string };

/**
 * Run the whole sign-in.
 *
 * The token is returned to the caller to save — this function never writes it,
 * never prints it, and never keeps it.
 */
export async function runFreepiLogin(deps: LoginDeps): Promise<LoginResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + (deps.deadlineMs ?? LOGIN_DEADLINE_MS);

  let start: DeviceStart;
  try {
    start = await startDeviceLogin(deps.baseUrl, fetchImpl, deps.identity);
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  }

  const minutes = Math.round((deps.deadlineMs ?? LOGIN_DEADLINE_MS) / 60_000);
  deps.open(start.verificationUriComplete ?? start.verificationUri);
  deps.log("");
  deps.log("Sign in to free-pi with GitHub. Three steps:");
  deps.log("");
  deps.log(`  1. Open this page: ${start.verificationUri}`);
  deps.log(`  2. Type this code: ${start.userCode}`);
  deps.log("  3. Press the green Authorize button.");
  deps.log("");
  deps.log("If no browser opened, copy that page link into your own browser.");
  if (deps.inviteUrl) {
    deps.log(`No free-pi account yet? Make one here first, then do step 1: ${deps.inviteUrl}`);
  }
  deps.log(`Waiting for GitHub for up to ${minutes} minutes…`);
  deps.log("");

  while (now() < deadline) {
    const poll = await pollForToken(deps.baseUrl, start.sessionId, fetchImpl, deps.identity);
    if (poll.status === "issued") return { ok: true, token: poll.token };

    if (poll.status === "consent") {
      // free-pi's own words, and a real yes. Silence is a no.
      deps.log("free-pi needs your consent before it can finish the sign-in.");
      deps.log(FREEPI_CONSENT_TEXT);
      if (!(await deps.confirm("Accept these terms? [y/N]"))) {
        return { ok: false, reason: "Consent was declined, so nothing was saved." };
      }
      if (!(await acceptConsent(deps.baseUrl, start.sessionId, fetchImpl, deps.attribution))) {
        return { ok: false, reason: "free-pi did not record the consent. Try again in a minute." };
      }
      deps.log(`Consent saved. Now open ${start.verificationUri} and type ${start.userCode}.`);
      continue;
    }

    const wait = (poll.retryAfterSeconds ?? start.intervalSeconds) * 1000;
    await sleep(wait);
  }

  return {
    ok: false,
    reason: `Sign-in did not finish in ${minutes} minutes. Nothing was saved.`,
  };
}

/**
 * The consent question, asked in a real terminal.
 *
 * A pipe or a script gets `false`: silence must never accept terms on someone's
 * behalf, so a non-interactive run saves nothing.
 */
export async function askYesInteractive(question: string): Promise<boolean> {
  if (process.stdin.isTTY !== true) return false;
  const { createInterface } = await import("node:readline");
  const rl = createInterface(process.stdin, process.stdout);
  try {
    const answer = await new Promise<string>((resolve) => rl.question(`${question} `, resolve));
    return /^\s*y(es)?\s*$/i.test(answer);
  } finally {
    rl.close();
  }
}
