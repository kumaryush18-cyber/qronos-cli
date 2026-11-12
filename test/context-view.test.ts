import { describe, expect, test } from "bun:test";
import {
  formatContextBreakdown,
  formatTokenCount,
  getLatestContextStats,
  renderContextFooterTag,
  updateContextStats,
} from "../src/context-view";

describe("context-view (Item ④: Context Visibility)", () => {
  test("formatTokenCount formats small, medium, and large numbers cleanly", () => {
    expect(formatTokenCount(500)).toBe("500");
    expect(formatTokenCount(1500)).toBe("1.5k");
    expect(formatTokenCount(45_000)).toBe("45k");
    expect(formatTokenCount(1_200_000)).toBe("1.2M");
  });

  test("renderContextFooterTag renders percentage and handles threshold alerts", () => {
    // Normal usage (< 70%) -> dim color
    const normal = renderContextFooterTag({
      usedTokens: 20_000,
      contextWindow: 200_000,
    });
    expect(normal).toBeDefined();
    expect(normal).toContain("20k/200k (10%)");
    expect(normal).toContain("\x1b[2m");

    // Warning usage (70% - 89%) -> yellow color
    const warning = renderContextFooterTag({
      usedTokens: 160_000,
      contextWindow: 200_000,
    });
    expect(warning).toBeDefined();
    expect(warning).toContain("160k/200k (80%)");
    expect(warning).toContain("\x1b[33m");

    // Critical usage (>= 90%) -> bold red color with compact alert
    const critical = renderContextFooterTag({
      usedTokens: 190_000,
      contextWindow: 200_000,
    });
    expect(critical).toBeDefined();
    expect(critical).toContain("190k/200k (95%)");
    expect(critical).toContain("[compact soon]");
    expect(critical).toContain("\x1b[31;1m");
  });

  test("formatContextBreakdown renders visual progress bar and token details", () => {
    const text = formatContextBreakdown(
      {
        usedTokens: 50_000,
        contextWindow: 200_000,
        inputTokens: 40_000,
        outputTokens: 10_000,
        cacheReadTokens: 15_000,
      },
      "claude-sonnet-5.5",
    );

    expect(text).toContain("Context Window Usage (25.0%)");
    expect(text).toContain("50k / 200k tokens");
    expect(text).toContain("Active Model:       claude-sonnet-5.5");
    expect(text).toContain("Context Window:     200,000 tokens");
    expect(text).toContain("Headroom Remaining: 150,000 tokens");
    expect(text).toContain("Cache Read:         15,000");
  });

  test("updateContextStats and getLatestContextStats persist across reads", () => {
    updateContextStats({
      usedTokens: 75_000,
      contextWindow: 128_000,
    });

    const stats = getLatestContextStats();
    expect(stats).toBeDefined();
    expect(stats?.usedTokens).toBe(75_000);
    expect(stats?.contextWindow).toBe(128_000);
  });
});
