// The identity headers our requests carry, for both ad services.
//
// Why one builder: free-pi and our own Gravity service both need to know which
// client is asking and in which session. Two hand-written header lists drift,
// and a drifted header is how a request starts looking like a different client.
//
// Rules kept here:
//   - a value that is unknown is left out, never sent as "undefined";
//   - the ad context is one clean line, cut short, so a long prompt cannot
//     become a 40 KB header;
//   - no token, no email, no machine id. Session id only.
import { cleanLine } from "./tool-step";

export interface ClientIdentity {
  /** CLI version, e.g. `1.0.30`. */
  version: string;
  /** `linux`, `darwin`, `win32`, … */
  os: string;
  /** `x64`, `arm64`, … */
  arch: string;
}

/** The longest ad context we send, in characters. */
export const AD_CONTEXT_MAX_CHARS = 200;

export function clientIdentity(
  env: {
    version: string;
    platform?: NodeJS.Platform;
    arch?: string;
  },
): ClientIdentity {
  return {
    version: env.version,
    os: env.platform ?? process.platform,
    arch: env.arch ?? process.arch,
  };
}

/**
 * Which client asked: version, OS, architecture.
 *
 * These are the same three facts free-pi's own client reports, and the same
 * three our Gravity service records, so no service gets a different picture of
 * one machine.
 */
export function clientHeaders(identity: ClientIdentity): Record<string, string> {
  const headers: Record<string, string> = {};
  if (identity.version.trim() !== "") headers["x-client-version"] = identity.version.trim();
  if (identity.os.trim() !== "") headers["x-client-os"] = identity.os.trim();
  if (identity.arch.trim() !== "") headers["x-client-arch"] = identity.arch.trim();
  return headers;
}

/** A prompt turned into an ad context: one line, no colours, cut at 200 chars. */
export function adContextFrom(prompt: string | undefined): string | undefined {
  if (!prompt) return undefined;
  const line = cleanLine(prompt, AD_CONTEXT_MAX_CHARS);
  return line === "" ? undefined : line;
}

export interface AdRequestHeaderInput {
  identity: ClientIdentity;
  /** One per token, kept — never a fresh id per request. */
  sessionId: string;
  /** Topic of the current turn, when there is one. */
  adContext?: string;
}

/**
 * The headers for an ad request or an impression.
 *
 * `x-session-id` comes from the caller because free-pi binds one id per token
 * and our Gravity session has its own; the rest are the same everywhere.
 */
export function adRequestHeaders(input: AdRequestHeaderInput): Record<string, string> {
  const headers: Record<string, string> = { ...clientHeaders(input.identity) };
  if (input.sessionId.trim() !== "") headers["x-session-id"] = input.sessionId.trim();
  const context = adContextFrom(input.adContext);
  if (context) headers["x-ad-context"] = context;
  return headers;
}

/** The headers for a model request: identity plus the token's own session id. */
export function modelRequestHeaders(identity: ClientIdentity, sessionId: string): Record<string, string> {
  const headers: Record<string, string> = { ...clientHeaders(identity) };
  if (sessionId.trim() !== "") headers["x-session-id"] = sessionId.trim();
  return headers;
}
