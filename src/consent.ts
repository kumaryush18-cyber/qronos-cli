export const CONSENT_TEXT = `
◈ Qronos CLI — Privacy & Transparency Notice

  * Privacy-First: We do NOT log, store, or inspect your source code, files, or
    prompts for AI model training. Your code remains 100% yours.
  * Zero Data Selling: We never sell, share, or trade your code, data, or personal
    information with third parties.
  * Developer-Sponsored Inference: Free inference tiers are funded by discreet
    developer tool sponsors (e.g. Supabase, Neon, Vercel) displayed in the terminal.
    Ad content is purely visual and never enters your AI model context.
  * Local Execution: Tool operations (bash, file reading, file edits, git workflows)
    execute locally on your computer with interactive permission controls.
  * Universal Gateway: Secure requests route through Qronos AI's identity-shielded
    gateway (https://api.qronos.me).

By continuing, you agree to the Qronos Terms of Service (https://qronos.me/terms)
and Privacy Policy (https://qronos.me/privacy).

Decline and no network requests will be made.
`.trim();

export const CONSENT_VERSION = "qronos-v1";

/**
 * Shown instead of the consent screen when stdin is not a TTY.
 */
export const NON_INTERACTIVE_CONSENT_TEXT =
  "Qronos CLI first-run consent requires an interactive terminal. " +
  "Run `npx qronos-cli` in a terminal once to review and accept; " +
  "after that, non-interactive runs work.";

export const CONSENT_PROMPT = "Accept? [y/N] ";

export function parseConsentAnswer(answer: string): boolean {
  return /^\s*y(es)?\s*$/i.test(answer);
}

/** Consent screen for an already-signed-in user: only the last line differs. */
export const REPROMPT_CONSENT_TEXT = CONSENT_TEXT.replace(
  "Decline and no network requests will be made.",
  "Decline and Qronos CLI exits; you will be asked again next time.",
);
