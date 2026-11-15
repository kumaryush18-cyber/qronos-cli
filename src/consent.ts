// Engaging Orange Brand Palette
const ORANGE_BOLD = "\x1b[1;38;2;255;107;0m";
const ORANGE_LIGHT = "\x1b[38;2;255;170;86m";
const WHITE_BOLD = "\x1b[1;37m";
const MUTED = "\x1b[38;2;148;163;184m";
const RESET = "\x1b[0m";

export const CONSENT_TEXT = `
${ORANGE_BOLD}◈ Qronos CLI — Privacy & Transparency Notice${RESET}

  ${ORANGE_BOLD}•${RESET} ${WHITE_BOLD}Privacy-First:${RESET} ${ORANGE_LIGHT}We do NOT log, store, or inspect your source code, files, or${RESET}
    ${ORANGE_LIGHT}prompts for AI model training. Your code remains 100% yours.${RESET}
  ${ORANGE_BOLD}•${RESET} ${WHITE_BOLD}Zero Data Selling:${RESET} ${ORANGE_LIGHT}We never sell, share, or trade your code, data, or personal${RESET}
    ${ORANGE_LIGHT}information with third parties.${RESET}
  ${ORANGE_BOLD}•${RESET} ${WHITE_BOLD}Developer-Sponsored Inference:${RESET} ${ORANGE_LIGHT}Free inference tiers are funded by discreet${RESET}
    ${ORANGE_LIGHT}developer tool sponsors (e.g. Supabase, Neon, Vercel) displayed in the terminal.${RESET}
    ${ORANGE_LIGHT}Ad content is purely visual and never enters your AI model context.${RESET}
  ${ORANGE_BOLD}•${RESET} ${WHITE_BOLD}Local Execution:${RESET} ${ORANGE_LIGHT}Tool operations (bash, file reading, file edits, git workflows)${RESET}
    ${ORANGE_LIGHT}execute locally on your computer with interactive permission controls.${RESET}
  ${ORANGE_BOLD}•${RESET} ${WHITE_BOLD}Universal Gateway:${RESET} ${ORANGE_LIGHT}Secure requests route through Qronos AI's identity-shielded${RESET}
    ${ORANGE_LIGHT}gateway (https://api.qronos.me).${RESET}

${MUTED}By continuing, you agree to the Qronos Terms of Service (https://qronos.me/terms)${RESET}
${MUTED}and Privacy Policy (https://qronos.me/privacy).${RESET}

${MUTED}Decline and no network requests will be made.${RESET}
`.trim();

export const CONSENT_VERSION = "qronos-v1";

/**
 * Shown instead of the consent screen when stdin is not a TTY.
 */
export const NON_INTERACTIVE_CONSENT_TEXT =
  "Qronos CLI first-run consent requires an interactive terminal. " +
  "Run `npx qronos-cli` in a terminal once to review and accept; " +
  "after that, non-interactive runs work.";

export const CONSENT_PROMPT = `${ORANGE_BOLD}❯${RESET} Accept? [y/N] `;

export function parseConsentAnswer(answer: string): boolean {
  return /^\s*y(es)?\s*$/i.test(answer);
}

/** Consent screen for an already-signed-in user: only the last line differs. */
export const REPROMPT_CONSENT_TEXT = CONSENT_TEXT.replace(
  "Decline and no network requests will be made.",
  "Decline and Qronos CLI exits; you will be asked again next time.",
);
