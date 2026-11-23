export const DEFAULT_BASE_URL = "https://api.qronos.me";

export function resolveBaseUrl(env: Record<string, string | undefined> = process.env): string {
  return env.QRONOS_BASE_URL || DEFAULT_BASE_URL;
}

/** pi's two rendering modes. */
export type TuiModeSetting = "regular" | "fullscreen";

/**
 * Which TUI mode to start in.
 *
 * fullscreen (the default) draws on the alternate screen. That is what makes
 * the terminal send mouse events, so clicking inside the input box puts the
 * cursor where you clicked. regular keeps the terminal's own scrollback but the
 * terminal never reports clicks there, so click-to-cursor cannot work.
 *
 * QRONOS_TUI_MODE=regular brings the old behaviour back.
 */
export function resolveTuiMode(env: Record<string, string | undefined> = process.env): TuiModeSetting {
  const raw = (env.QRONOS_TUI_MODE || "").trim().toLowerCase();
  return raw === "regular" ? "regular" : "fullscreen";
}

/**
 * Claude-style step names on shell tools, on by default.
 *
 * When on, bash and powershell carry an optional `description` the model
 * fills with one short sentence, and the transcript draws it above the
 * command. QRONOS_TOOL_DESCRIPTIONS=0 removes the field from the schema and
 * the line from the display, so nothing is asked for and nothing is spent.
 *
 * Schema and renderer read this same function: they must agree, or the model
 * would write a sentence that is never shown.
 */
export function toolDescriptionsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.QRONOS_TOOL_DESCRIPTIONS ?? "1").trim() !== "0";
}
