// Output-token counting for the working line (see working-line.ts for the UI).
//
// 1.0.5 used ctx.getContextUsage().tokens, which only moves when a message is
// added — while the model writes it does not change, so the number looked
// frozen at whatever it was (e.g. "6.5k"). This module counts the tokens the
// model is producing right now instead.
//
// Where the number comes from, in order of trust:
//   1. message.usage.output — the provider's own count. pi-ai updates it *during*
//      the stream for Anthropic-style APIs (message_delta.usage.output_tokens).
//   2. An estimate from the characters received so far (chars / 4), because
//      OpenAI-style streams only send usage in the final chunk. Without this the
//      count would sit at 0 and then jump once at the end.
// Both are kept, and the larger one is shown, so the number only ever goes up.

/** Rough tokens per character for streaming text. English prose is ~4 chars/token. */
export const CHARS_PER_TOKEN = 4;

/**
 * Compact token count: 847 -> "847", 12_340 -> "12.3k", 1_240_000 -> "1.2M".
 * Returns undefined when the number is unknown so the caller can fall back.
 */
export function formatTokenCount(tokens: number | null | undefined): string | undefined {
  if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens < 0) return undefined;
  const n = Math.floor(tokens);
  if (n < 1000) return String(n);
  if (n < 1_000_000) {
    const k = n / 1000;
    return `${k < 10 ? k.toFixed(1) : String(Math.round(k))}k`;
  }
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Streaming estimate: how many tokens the characters received so far are worth. */
export function estimateTokensFromChars(chars: number): number {
  if (!Number.isFinite(chars) || chars <= 0) return 0;
  return Math.round(chars / CHARS_PER_TOKEN);
}

/** Minimal shapes of the pi events this module reads. */
interface AnyMessage {
  role?: string;
  usage?: { output?: number } | undefined;
}
interface AnyStreamEvent {
  delta?: unknown;
  type?: string;
}

/**
 * Counts output tokens for the current turn.
 *
 * A turn can contain several assistant messages (tool call -> tool result ->
 * next message), so finished messages are added to a base and the streaming one
 * is added on top. That makes the number grow for the whole turn, like Claude
 * Code, instead of resetting on every tool call.
 */
export class OutputTokenCounter {
  private base = 0;
  private chars = 0;
  private real = 0;

  /** Tokens produced so far in this turn. Monotonic while the turn runs. */
  tokens(): number {
    return this.base + Math.max(this.real, estimateTokensFromChars(this.chars));
  }

  /** A new assistant message starts streaming: count it from zero again. */
  messageStart(message: unknown): void {
    if (!isAssistant(message)) return;
    this.chars = 0;
    this.real = 0;
  }

  /** Streaming update: take the provider count and/or add the new characters. */
  messageUpdate(message: unknown, streamEvent?: unknown): void {
    if (!isAssistant(message)) return;
    const output = message.usage?.output;
    if (typeof output === "number" && output > this.real) this.real = output;
    const delta = (streamEvent as AnyStreamEvent | undefined)?.delta;
    if (typeof delta === "string") this.chars += delta.length;
  }

  /** Message finished: freeze its count into the turn total. */
  messageEnd(message: unknown): void {
    if (!isAssistant(message)) return;
    const output = message.usage?.output;
    if (typeof output === "number" && output > this.real) this.real = output;
    this.base += Math.max(this.real, estimateTokensFromChars(this.chars));
    this.chars = 0;
    this.real = 0;
  }

  /** New turn (or new session): forget the previous total. */
  reset(): void {
    this.base = 0;
    this.chars = 0;
    this.real = 0;
  }
}

function isAssistant(message: unknown): message is AnyMessage {
  return (message as AnyMessage | undefined)?.role === "assistant";
}
