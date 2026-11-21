import { describe, expect, test } from "bun:test";
import {
  MAX_SUMMARY_CHARS,
  MIN_HEADINGS,
  SUMMARY_HEADINGS,
  SUMMARY_SYSTEM_PROMPT,
  approxTokens,
  buildCompactPrompt,
  compactStatusLine,
  countingHeadings,
  readSummary,
  withEvidence,
} from "../src/compact-summary";
import type { CompactEvidence } from "../src/compact-digest";

const goodSummary = `## Goal
Ship the login fix.

## Constraints & Preferences
- bun only

## Progress
- [x] found the bug
- [ ] wrote the test

## Key Decisions
- **keep the API**: the UI already calls it

## Errors & Open Questions
- (none)

## Next Steps
1. run the suite

## Critical Context
- src/auth.ts:42`;

const emptyEvidence: CompactEvidence = {
  files: [],
  commands: [],
  errors: [],
  stats: { messages: 0, toolCalls: 0, charsIn: 0, charsOut: 0 },
};

describe("the prompt", () => {
  test("asks for the headings we validate later", () => {
    for (const heading of SUMMARY_HEADINGS) expect(SUMMARY_SYSTEM_PROMPT).toContain(heading);
  });

  test("says not to invent facts", () => {
    expect(SUMMARY_SYSTEM_PROMPT).toContain("Never invent");
  });

  test("includes the conversation", () => {
    const prompt = buildCompactPrompt({ transcript: "USER:\nhello", evidence: emptyEvidence });
    expect(prompt).toContain("<conversation>");
    expect(prompt).toContain("USER:\nhello");
  });

  test("adds the previous checkpoint when updating", () => {
    const prompt = buildCompactPrompt({
      transcript: "x",
      evidence: emptyEvidence,
      previousSummary: "## Goal\nold goal",
    });
    expect(prompt).toContain("<previous-checkpoint>");
    expect(prompt).toContain("## Goal\nold goal");
    expect(prompt).toContain("Keep every fact");
  });

  test("includes recorded facts", () => {
    const prompt = buildCompactPrompt({
      transcript: "x",
      evidence: { ...emptyEvidence, files: ["src/a.ts"] },
    });
    expect(prompt).toContain("<recorded-facts>");
    expect(prompt).toContain("src/a.ts");
  });

  test("passes the user's focus through", () => {
    const prompt = buildCompactPrompt({ transcript: "x", evidence: emptyEvidence, customInstructions: "keep the API notes" });
    expect(prompt).toContain("focus on: keep the API notes");
  });

  test("mentions a split turn", () => {
    const prompt = buildCompactPrompt({ transcript: "x", evidence: emptyEvidence, isSplitTurn: true });
    expect(prompt).toContain("middle of a turn");
  });

  test("caps the whole prompt", () => {
    const prompt = buildCompactPrompt({ transcript: "x".repeat(200_000), evidence: emptyEvidence });
    expect(prompt.length).toBeLessThan(70_000);
    expect(prompt).toContain("[truncated]");
  });
});

describe("readSummary", () => {
  test("accepts a complete summary", () => {
    const read = readSummary(goodSummary);
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.summary).toContain("## Goal");
  });

  test("rejects an empty answer", () => {
    const read = readSummary("   ");
    expect(read).toEqual({ ok: false, reason: "empty answer" });
  });

  test("rejects a truncated answer with too few headings", () => {
    const read = readSummary("## Goal\nsomething\n## Progress\n- [x] x");
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.reason).toContain("headings");
  });

  test("rejects a plain prose answer", () => {
    expect(readSummary("I looked at the code and it seems fine to me, all tests pass.").ok).toBe(false);
  });

  test("rejects an answer that is headings but nearly empty", () => {
    const tiny = SUMMARY_HEADINGS.slice(0, MIN_HEADINGS).join("\n");
    expect(readSummary(tiny).ok).toBe(false);
  });

  test("unwraps a fenced answer", () => {
    const read = readSummary("```markdown\n" + goodSummary + "\n```");
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.summary.startsWith("## Goal")).toBe(true);
  });

  test("redacts a secret before storing", () => {
    const read = readSummary(`${goodSummary}\n- key ghp_${"a".repeat(36)}`);
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.summary).not.toContain("ghp_");
  });

  test("redaction is idempotent", () => {
    const once = readSummary(`${goodSummary}\n- key AKIAIOSFODNN7EXAMPLE`);
    expect(once.ok).toBe(true);
    if (!once.ok) return;
    const twice = readSummary(once.summary);
    expect(twice.ok).toBe(true);
    if (twice.ok) expect(twice.summary).toBe(once.summary);
  });

  test("clamps a giant summary", () => {
    const huge = `${goodSummary}\n${"filler line\n".repeat(5000)}`;
    const read = readSummary(huge, { maxChars: 500 });
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.summary.length).toBeLessThan(600);
      expect(read.summary).toContain("[summary truncated]");
    }
  });

  test("the default cap is the documented one", () => {
    expect(MAX_SUMMARY_CHARS).toBe(12_000);
  });
});

describe("countingHeadings", () => {
  test("counts a full summary", () => {
    expect(countingHeadings(goodSummary)).toBe(SUMMARY_HEADINGS.length);
  });

  test("counts none in prose", () => {
    expect(countingHeadings("hello")).toBe(0);
  });
});

describe("withEvidence", () => {
  test("appends the recorded facts", () => {
    const combined = withEvidence("## Goal\nx", {
      ...emptyEvidence,
      files: ["src/a.ts"],
      errors: ["TypeError: boom"],
    });
    expect(combined).toContain("## Exact Evidence");
    expect(combined).toContain("src/a.ts");
  });

  test("is idempotent", () => {
    const evidence = { ...emptyEvidence, files: ["a.ts"] };
    const once = withEvidence("## Goal\nx", evidence);
    expect(withEvidence(once, evidence)).toBe(once);
  });

  test("changes nothing when there is no evidence", () => {
    expect(withEvidence("## Goal\nx", emptyEvidence)).toBe("## Goal\nx");
  });
});

describe("compactStatusLine", () => {
  test("shows thousands both sides", () => {
    expect(compactStatusLine(48_000, 12_400)).toBe("compacted 48k → 3.1k tokens");
  });

  test("shows small numbers plainly", () => {
    expect(compactStatusLine(900, 400)).toBe("compacted 900 → 100 tokens");
  });

  test("never says zero tokens after", () => {
    expect(compactStatusLine(100, 0)).toContain("→ 1 tokens");
  });
});

describe("approxTokens", () => {
  test("is four characters per token", () => {
    expect(approxTokens("abcd")).toBe(1);
    expect(approxTokens("a".repeat(400))).toBe(100);
  });
});