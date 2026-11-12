import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const CLAUDE_THEME_NAME = "qronos-claude";

export const CLAUDE_THEME_JSON = {
  "$schema": "https://qronos.dev/schemas/theme.schema.json",
  "name": CLAUDE_THEME_NAME,
  "appearance": "dark",
  "vars": {
    "text": "#e6edf3",
    "muted": "#8b949e",
    "dim": "#6e7681",
    "keywordRed": "#ff7b72",
    "functionBlue": "#79c0ff",
    "stringGreen": "#7ee787",
    "numberOrange": "#ffa657",
    "typeYellow": "#e5c07b",
    "variablePurple": "#d2a8ff",
    "diffGreen": "#3fb950",
    "diffRed": "#f85149",
    "borderMuted": "#30363d",
    "userGrey": "#373737"
  },
  "colors": {
    "accent": "keywordRed",
    "border": "borderMuted",
    "borderAccent": "keywordRed",
    "borderMuted": "borderMuted",
    "success": "diffGreen",
    "error": "diffRed",
    "warning": "numberOrange",
    "muted": "muted",
    "dim": "dim",
    "text": "text",
    "thinkingText": "muted",
    // All background panel fills set to "" except userMessageBg which uses Claude Code #373737
    "selectedBg": "",
    "searchMatchBg": "",
    "searchMatchText": "text",
    "userMessageBg": "userGrey",
    "userMessageText": "text",
    "customMessageBg": "",
    "customMessageText": "muted",
    "customMessageLabel": "keywordRed",
    "toolPendingBg": "",
    "toolSuccessBg": "",
    "toolErrorBg": "",
    "toolTitle": "text",
    "toolOutput": "text",
    "mdHeading": "keywordRed",
    "mdLink": "functionBlue",
    "mdLinkUrl": "muted",
    "mdCode": "typeYellow",
    "mdCodeBlock": "text",
    "mdCodeBlockBorder": "borderMuted",
    "mdQuote": "muted",
    "mdQuoteBorder": "borderMuted",
    "mdHr": "borderMuted",
    "mdListBullet": "keywordRed",
    "toolDiffAdded": "diffGreen",
    "toolDiffRemoved": "diffRed",
    "toolDiffContext": "dim",
    "syntaxComment": "muted",
    "syntaxKeyword": "keywordRed",
    "syntaxFunction": "functionBlue",
    "syntaxVariable": "text",
    "syntaxString": "stringGreen",
    "syntaxNumber": "numberOrange",
    "syntaxType": "typeYellow",
    "syntaxOperator": "muted",
    "syntaxPunctuation": "dim",
    "thinkingOff": "dim",
    "thinkingMinimal": "dim",
    "thinkingLow": "muted",
    "thinkingMedium": "numberOrange",
    "thinkingHigh": "keywordRed",
    "thinkingXhigh": "diffRed",
    "thinkingMax": "diffRed",
    "bashMode": "diffGreen"
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
