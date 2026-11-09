import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const CLAUDE_THEME_NAME = "qronos-claude";

export const CLAUDE_THEME_JSON = {
  "$schema": "https://pi.dev/schemas/theme.schema.json",
  "name": CLAUDE_THEME_NAME,
  "appearance": "dark",
  "vars": {
    "text": "okhsl(234 3% 89%)",
    "muted": "okhsl(229 6% 67%)",
    "dim": "okhsl(229 8% 50%)",
    "amber": "okhsl(55 90% 55%)",
    "terracotta": "okhsl(28 85% 58%)",
    "blue": "okhsl(232 54% 67%)",
    "green": "okhsl(159 59% 67%)",
    "red": "okhsl(20 72% 67%)",
    "yellow": "okhsl(83 88% 67%)",
    "borderMuted": "okhsl(229 8% 30%)"
  },
  "colors": {
    "accent": "terracotta",
    "border": "okhsl(231 20% 35%)",
    "borderAccent": "terracotta",
    "borderMuted": "okhsl(229 8% 30%)",
    "success": "green",
    "error": "red",
    "warning": "yellow",
    "muted": "muted",
    "dim": "okhsl(229 8% 50%)",
    "text": "text",
    "thinkingText": "muted",
    // All background panel fills set to "" (empty = transparent terminal default!)
    "selectedBg": "",
    "searchMatchBg": "",
    "searchMatchText": "text",
    "userMessageBg": "",
    "userMessageText": "text",
    "customMessageBg": "",
    "customMessageText": "muted",
    "customMessageLabel": "terracotta",
    "toolPendingBg": "",
    "toolSuccessBg": "",
    "toolErrorBg": "",
    "toolTitle": "text",
    "toolOutput": "muted",
    "mdHeading": "terracotta",
    "mdLink": "blue",
    "mdLinkUrl": "muted",
    "mdCode": "amber",
    "mdCodeBlock": "text",
    "mdCodeBlockBorder": "borderMuted",
    "mdQuote": "muted",
    "mdQuoteBorder": "borderMuted",
    "mdHr": "borderMuted",
    "mdListBullet": "terracotta",
    "toolDiffAdded": "green",
    "toolDiffRemoved": "red",
    "toolDiffContext": "muted",
    "syntaxComment": "dim",
    "syntaxKeyword": "terracotta",
    "syntaxFunction": "yellow",
    "syntaxVariable": "text",
    "syntaxString": "green",
    "syntaxNumber": "amber",
    "syntaxType": "amber",
    "syntaxOperator": "muted",
    "syntaxPunctuation": "muted",
    "thinkingOff": "dim",
    "thinkingMinimal": "dim",
    "thinkingLow": "muted",
    "thinkingMedium": "amber",
    "thinkingHigh": "terracotta",
    "thinkingXhigh": "red",
    "thinkingMax": "red",
    "bashMode": "green"
  }
};

/**
 * Ensures the clean Claude-inspired theme file exists in the agent directory.
 */
export async function ensureQronosTheme(agentDir: string): Promise<string> {
  const themesDir = join(agentDir, "themes");
  await mkdir(themesDir, { recursive: true });
  const themePath = join(themesDir, `${CLAUDE_THEME_NAME}.json`);
  await writeFile(themePath, JSON.stringify(CLAUDE_THEME_JSON, null, 2), "utf8");
  return CLAUDE_THEME_NAME;
}
