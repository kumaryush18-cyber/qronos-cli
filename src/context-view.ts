// Context visibility and window pressure tracking for Qronos CLI.
//
// Shows tokens used against the model's context window so auto-compaction
// is never an unexpected surprise.
//
// Surfaces in two places:
//   1. /context slash command: detailed breakdown of input, output, cache, and window headroom.
//   2. Footer status indicator: compact token count and percentage meter.

export interface ContextStats {
  usedTokens: number;
  contextWindow: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

let latestStats: ContextStats | undefined;

export function updateContextStats(stats: ContextStats): void {
  latestStats = stats;
}

export function getLatestContextStats(): ContextStats | undefined {
  return latestStats;
}

export function formatTokenCount(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

/** Render a single compact footer tag, e.g. "45k/200k (23%)" */
export function renderContextFooterTag(stats: ContextStats | undefined): string | undefined {
  if (!stats || stats.contextWindow <= 0 || stats.usedTokens <= 0) return undefined;

  const percent = Math.min(100, Math.round((stats.usedTokens / stats.contextWindow) * 100));
  const used = formatTokenCount(stats.usedTokens);
  const total = formatTokenCount(stats.contextWindow);

  const RESET = "\x1b[0m";
  let color = "\x1b[2m"; // dim
  if (percent >= 90) {
    color = "\x1b[31;1m"; // bold red
  } else if (percent >= 70) {
    color = "\x1b[33m"; // yellow
  }

  const alert = percent >= 90 ? " [compact soon]" : "";
  return `${color}${used}/${total} (${percent}%)${alert}${RESET}`;
}

/** Detailed formatted text for `/context` slash command. */
export function formatContextBreakdown(stats: ContextStats | undefined, modelName?: string): string {
  if (!stats || stats.contextWindow <= 0) {
    return [
      "No context usage recorded yet for this session.",
      "Send a prompt to populate token usage metrics.",
    ].join("\n");
  }

  const percent = Math.min(100, (stats.usedTokens / stats.contextWindow) * 100);
  const remaining = Math.max(0, stats.contextWindow - stats.usedTokens);

  const barWidth = 24;
  const filled = Math.min(barWidth, Math.round((percent / 100) * barWidth));
  const empty = barWidth - filled;
  const bar = `[${"█".repeat(filled)}${"░".repeat(empty)}]`;

  const lines = [
    `Context Window Usage (${percent.toFixed(1)}%)`,
    `${bar} ${formatTokenCount(stats.usedTokens)} / ${formatTokenCount(stats.contextWindow)} tokens`,
    "",
    `  • Active Model:       ${modelName || "Current Model"}`,
    `  • Context Window:     ${stats.contextWindow.toLocaleString()} tokens`,
    `  • Current Context:    ${stats.usedTokens.toLocaleString()} tokens`,
    `  • Headroom Remaining: ${remaining.toLocaleString()} tokens`,
  ];

  if (stats.inputTokens !== undefined) {
    lines.push(`  • Input Tokens:       ${stats.inputTokens.toLocaleString()}`);
  }
  if (stats.outputTokens !== undefined) {
    lines.push(`  • Output Tokens:      ${stats.outputTokens.toLocaleString()}`);
  }
  if (stats.cacheReadTokens !== undefined && stats.cacheReadTokens > 0) {
    lines.push(`  • Cache Read:         ${stats.cacheReadTokens.toLocaleString()}`);
  }
  if (stats.cacheWriteTokens !== undefined && stats.cacheWriteTokens > 0) {
    lines.push(`  • Cache Write:        ${stats.cacheWriteTokens.toLocaleString()}`);
  }

  lines.push("");
  if (percent >= 85) {
    lines.push("⚠️ High context pressure! Run /compact to summarize history and free window space.");
  } else {
    lines.push("Tip: Auto-compaction triggers automatically when approaching the model's context limit.");
  }

  return lines.join("\n");
}
