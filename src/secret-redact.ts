// Secret redaction for everything memory writes to disk.
//
// Why this is not optional: memory is the only feature that copies parts of a
// conversation into a file that later goes back INTO a prompt. A key pasted
// once into the chat would otherwise live in MEMORY.md forever, be injected
// into every future session, and be synced to any machine that copies the
// agent dir. Redaction runs on every write, and again on model output, so a
// hallucinated key cannot land either.
//
// Design rules:
// - Only remove things that are almost certainly secrets. A memory that eats
//   the word "token" out of "token budget" is worse than useless.
// - Idempotent: redactSecrets(redactSecrets(x)) === redactSecrets(x), so a
//   second write pass cannot grow the text.
// - No dependencies, no fs, no model. Pure string in, string out.
export const REDACTED = "[redacted]";

/**
 * Token shapes with a fixed, recognisable prefix. Each one is a real format
 * from a provider we support, so a false positive is close to impossible.
 */
const TOKEN_SHAPES: ReadonlyArray<RegExp> = [
  // OpenAI / Anthropic / generic "sk-" keys.
  /\bsk-[A-Za-z0-9_-]{12,}/g,
  // GitHub: classic PAT, fine-grained PAT, app, oauth, server, refresh.
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  // AWS access key id (+ a matching secret is caught by the assignment rule).
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bASIA[0-9A-Z]{16}\b/g,
  // Slack.
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  // Stripe.
  /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g,
  // Google API key.
  /\bAIza[0-9A-Za-z_-]{35,40}/g,
  // Telegram bot token: <id>:<35 chars>. The id is 8-10 digits, never a date.
  /\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/g,
  // JSON Web Token (header.payload.signature), all base64url.
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  // OpenSSH private key body (also covered by the PEM rule below).
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  // SSH public key bodies are not secret, but the comment after them often is
  // an email; leave those alone.
];

/**
 * `name = value` / `name: value` pairs, where the name says it is a secret.
 * The value must be at least 6 characters so prose like "token: none" or
 * "password: yes" is not touched.
 */
const ASSIGNMENT =
  /\b(api[_-]?key|apikey|access[_-]?key|secret[_-]?key|client[_-]?secret|private[_-]?key|auth[_-]?token|access[_-]?token|refresh[_-]?token|session[_-]?token|bearer|password|passwd|pwd)(["']?\s*[:=]\s*)("[^"\n]{6,}"|'[^'\n]{6,}'|[^\s,;"'`]{6,})/gi;

/** `Authorization: Bearer <token>` — the most common way a key leaks in a log. */
const BEARER = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi;

/** `https://user:password@host` — credentials inside a URL. */
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]{1,64}:[^/\s@]{1,128}@/gi;

/** A quoted long random string is not a secret on its own; skip it. */

function alreadyRedacted(text: string): boolean {
  return text.includes(REDACTED);
}

/**
 * Remove secret-looking substrings. Safe to call on prose, code, JSON and
 * markdown; never throws.
 */
export function redactSecrets(input: string): string {
  if (typeof input !== "string" || input === "") return "";
  let text = input;
  for (const pattern of TOKEN_SHAPES) {
    text = text.replace(pattern, (match) => (alreadyRedacted(match) ? match : REDACTED));
  }
  text = text.replace(ASSIGNMENT, (match, name: string, sep: string, value: string) => {
    if (value.includes(REDACTED)) return match;
    // Keep the quote style so the text still reads like valid config.
    const quote = value.startsWith('"') ? '"' : value.startsWith("'") ? "'" : "";
    return `${name}${sep}${quote}${REDACTED}${quote}`;
  });
  text = text.replace(BEARER, (match, prefix: string) => {
    if (match.includes(REDACTED)) return match;
    return `${prefix}${REDACTED}`;
  });
  text = text.replace(URL_CREDENTIALS, (match, scheme: string) =>
    match.includes(REDACTED) ? match : `${scheme}${REDACTED}@`,
  );
  return text;
}

/**
 * True when the text still looks like it carries a secret. Used as a last
 * gate before a write: if this says yes after redaction, the write is skipped
 * instead of storing something we do not understand.
 */
export function looksLikeSecret(input: string): boolean {
  if (typeof input !== "string" || input === "") return false;
  return redactSecrets(input) !== input;
}

/**
 * Redact + clamp in one step, which is what every memory writer actually
 * needs: redaction first (so a cut cannot leave half a key behind), then a
 * hard character cap with a visible marker.
 */
export function cleanText(input: string, maxChars: number): string {
  const clean = redactSecrets(typeof input === "string" ? input : "").replace(/\r\n/g, "\n");
  if (maxChars <= 0) return "";
  if (clean.length <= maxChars) return clean;
  return `${clean.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}
