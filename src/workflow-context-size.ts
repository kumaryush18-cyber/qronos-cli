// The model's context size, as a short tag: `[1m]`, `[200k]`, `[32k]`.
//
// Claude Code prints it next to the model name in the agent detail header, and it
// answers a real question at a glance: did this agent have room to read the whole
// file, or did it work blind? The number lives on the model, so it must be looked
// up when the agent starts and carried with the record: a later `/workflows` read
// has no registry to ask.

/** Shorten a context size to the tag's text. Unknown sizes give nothing. */
export function formatContextSize(tokens: number | undefined | null): string | undefined {
  if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens <= 0) return undefined;
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    // 1_000_000 is exactly `1m`; 1_048_576 is `1m` too, because a header is not an
    // invoice and a decimal there would only cost space.
    return `${trim(millions)}m`;
  }
  if (tokens >= 1_000) return `${trim(tokens / 1_000)}k`;
  return String(Math.round(tokens));
}

/** Drop a trailing `.0`, and keep one decimal when it says something. */
function trim(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : String(rounded);
}

/** `claude-haiku-5.5 [1m]`, or just the model, or just the tag. */
export function modelWithContext(model: string | undefined, tokens: number | undefined | null): string {
  const size = formatContextSize(tokens);
  const name = (model ?? "").trim();
  if (!size) return name;
  return name === "" ? `[${size}]` : `${name} [${size}]`;
}
