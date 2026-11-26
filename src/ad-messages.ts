// The real conversation, as the ad network needs to see it.
//
// Gravity's ops team told us plainly that a single topic line ("Coding and AI
// tools") makes our inventory cheap, because their engine prices real user +
// assistant turns. So this module reads the session branch and returns the last
// few real turns.
//
// Rules kept here:
//   - user and assistant turns only, in order;
//   - terminal colour codes and control bytes are stripped, because we are
//     sending text to a third party, not drawing it;
//   - a huge paste is cut, but at 4 000 characters per message, not 500 — the
//     cap is a size guard, not a targeting decision;
//   - secret-looking text is redacted before it leaves the machine.

import { redactSecrets } from "./secret-redact";

/** How many turns we send. The Gravity SDK forwards the last two itself. */
export const AD_MAX_MESSAGES = 8;
/** Per-message size guard. Not a relevance choice. */
export const AD_MESSAGE_MAX_CHARS = 4_000;
/** The header the gateway reads. Base64url JSON, so a newline cannot break it. */
export const AD_MESSAGES_HEADER = "x-ad-messages";
/** The header that carries a pre-hashed email. Never the address itself. */
export const AD_USER_HASH_HEADER = "x-ad-user-hash";

export interface AdMessage {
  role: "user" | "assistant";
  content: string;
}

const ANSI = /[\u001B\u009B][[\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

function cleanText(value: unknown): string {
  if (typeof value !== "string") return "";
  let text = value.replace(ANSI, "").replace(/\r/g, "");
  try {
    text = redactSecrets(text);
  } catch {
    // A redactor failure must not cost us the ad; the cap below still applies.
  }
  return text
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Pulls the text out of a pi message body, which may be a string or parts. */
export function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const text = (part as { text?: unknown }).text;
    if (typeof text === "string") parts.push(text);
  }
  return parts.join("\n");
}

/** Keeps only real turns, capped per message and in count. */
export function toAdMessages(raw: unknown): AdMessage[] {
  if (!Array.isArray(raw)) return [];
  const out: AdMessage[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const role = (entry as { role?: unknown }).role;
    if (role !== "user" && role !== "assistant") continue;
    let content = cleanText(textOfContent((entry as { content?: unknown }).content));
    if (!content) continue;
    if (content.length > AD_MESSAGE_MAX_CHARS) content = `${content.slice(0, AD_MESSAGE_MAX_CHARS - 1)}…`;
    out.push({ role, content });
  }
  return out.slice(-AD_MAX_MESSAGES);
}

/** Reads a pi session branch (entries that may wrap a message) into turns. */
export function messagesFromBranch(entries: unknown): AdMessage[] {
  if (!Array.isArray(entries)) return [];
  const collected: unknown[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const wrapped = (entry as { type?: string; message?: unknown }).message;
    const candidate = (entry as { type?: string }).type === "message" && wrapped ? wrapped : entry;
    collected.push(candidate);
  }
  return toAdMessages(collected);
}

/** The header must stay small: servers cap headers, and a 40 KB one is refused. */
export const AD_HEADER_MAX_CHARS = 8_000;

export function encodeMessagesHeader(messages: AdMessage[]): string | undefined {
  if (messages.length === 0) return undefined;
  // Keep the newest turns that fit. A trim here is size, never relevance: the
  // SDK forwards the last two turns anyway, so a long history shortens itself.
  const kept: AdMessage[] = [];
  let encoded = "";
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const candidate = [messages[i]!, ...kept];
    let next: string;
    try {
      next = Buffer.from(JSON.stringify(candidate), "utf8").toString("base64url");
    } catch {
      break;
    }
    if (next.length > AD_HEADER_MAX_CHARS && kept.length > 0) break;
    kept.unshift(messages[i]!);
    encoded = next;
  }
  return encoded || undefined;
}

/** A 64-character hex digest is the only shape we forward. */
export function cleanEmailHash(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(trimmed) ? trimmed : undefined;
}

/** The real user agent we send, built from what we actually know. */
export function userAgentFor(identity: { version: string; os: string; arch: string }): string {
  return `qronos-cli/${identity.version} (${identity.os}; ${identity.arch})`;
}
