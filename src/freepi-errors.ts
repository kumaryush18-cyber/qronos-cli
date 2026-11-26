// What the user reads when a free-pi request fails.
//
// The rule, the same one the Qronos gateway follows: a provider's insides are
// not the user's business. A "429 concurrent_session: token already has an
// active request" line teaches nobody anything and leaks our plumbing into the
// chat. So the message is MASKED into one of a few plain sentences, and the
// real text is kept for `QRONOS_DEBUG_FREEPI=1` only.
//
// Masking is not hiding a real problem: the sentence says what to do next. And
// an answer we did not recognise is never masked away — the server's own words
// are clearer than a made-up sentence would be.

/** The server's words for "this token is already in use". */
const CONCURRENT_PATTERNS: readonly RegExp[] = [
  /concurrent[_ ]session/i,
  /already (has|have) an active (request|session)/i,
  /only one (request|session) at a time/i,
  /session is busy/i,
  // Our own masked sentences, so detection still works after masking.
  /already has a live request/i,
  /already answering another request/i,
  /model is busy right now/i,
];

/** The server's words for "too many requests". */
const RATE_PATTERNS: readonly RegExp[] = [/rate[_ ]limit/i, /\b429\b/, /too many requests/i];

/** The server's words for "the model itself is having a bad day". */
const UNAVAILABLE_PATTERNS: readonly RegExp[] = [
  /\b50[0234]\b/,
  /unavailable/i,
  /overloaded/i,
  /high (usage|load|demand)/i,
  /temporarily/i,
  /capacity/i,
];

/** The server's words for "this key is not accepted". */
const TOKEN_PATTERNS: readonly RegExp[] = [/\b401\b/, /\b403\b/, /unauthori[sz]ed/i, /invalid (token|api key)/i, /forbidden/i];

/** The masked sentence for a busy or overloaded model. */
export const FREEPI_UNAVAILABLE_MESSAGE =
  "The selected model is at high usage right now and is unavailable. Please retry shortly.";

/** The masked sentence for a key that free-pi refused. */
export const FREEPI_TOKEN_REJECTED_MESSAGE =
  "This model is unavailable right now. Please retry shortly.";

/** Our own busy answer, kept because it says exactly what to do. */
export const FREEPI_CONCURRENT_MESSAGE =
  "This model is busy right now. Nothing was sent twice. Please retry shortly.";

export function isConcurrentSessionError(message: string | undefined): boolean {
  if (!message) return false;
  return CONCURRENT_PATTERNS.some((pattern) => pattern.test(message));
}

export function isRateLimitError(message: string | undefined): boolean {
  if (!message) return false;
  return RATE_PATTERNS.some((pattern) => pattern.test(message));
}

export function isUnavailableError(message: string | undefined): boolean {
  if (!message) return false;
  return UNAVAILABLE_PATTERNS.some((pattern) => pattern.test(message));
}

export function isTokenRejectedError(message: string | undefined): boolean {
  if (!message) return false;
  return TOKEN_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * The sentence the user sees for a free-pi failure.
 *
 * `undefined` means "say nothing of our own": the original message was not one
 * we recognise, so it is shown as it came.
 */
export function maskFreepiError(message: string | undefined): string | undefined {
  if (!message) return undefined;
  if (isTokenRejectedError(message)) return FREEPI_TOKEN_REJECTED_MESSAGE;
  if (isConcurrentSessionError(message)) return FREEPI_CONCURRENT_MESSAGE;
  if (isRateLimitError(message) || isUnavailableError(message)) return FREEPI_UNAVAILABLE_MESSAGE;
  return undefined;
}

/** True when the raw text asks for one retry: this token is already in use. */
export function wantsConcurrentRetry(message: string | undefined): boolean {
  return isConcurrentSessionError(message);
}
