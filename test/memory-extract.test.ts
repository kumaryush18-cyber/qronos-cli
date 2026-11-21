import { describe, expect, test } from "bun:test";
import {
  EXTRACTION_MAX_ENTRIES,
  EXTRACTION_SYSTEM_PROMPT,
  MAX_ITEM_CHARS,
  MIN_ITEM_CHARS,
  buildExtractionPrompt,
  isEmptyExtraction,
  parseExtraction,
  selectEntries,
} from "../src/memory-extract";
import type { JournalEntry } from "../src/memory-store";

function entry(seq: number, overrides: Partial<JournalEntry> = {}): JournalEntry {
  return { seq, at: 1_700_000_000_000, prompt: `p${seq}`, answer: `a${seq}`, tools: [], files: [], outcome: "ok", ...overrides };
}

describe("selectEntries", () => {
  test("only rows past lastSeq are taken", () => {
    const picked = selectEntries([entry(1), entry(2), entry(3)], 2);
    expect(picked.map((item) => item.seq)).toEqual([3]);
  });

  test("nothing new means nothing selected", () => {
    expect(selectEntries([entry(1)], 1)).toEqual([]);
  });

  test("the count cap is respected", () => {
    const rows = Array.from({ length: 40 }, (_, i) => entry(i + 1));
    expect(selectEntries(rows, 0).length).toBe(EXTRACTION_MAX_ENTRIES);
  });

  test("when the character cap trips, the newest rows win", () => {
    const rows = Array.from({ length: 5 }, (_, i) => entry(i + 1, { prompt: "x".repeat(600), answer: "y".repeat(600) }));
    const picked = selectEntries(rows, 0, { maxChars: 1500 });
    expect(picked.length).toBeGreaterThan(0);
    expect(picked.at(-1)!.seq).toBe(5);
  });

  test("the selection is returned oldest first", () => {
    const rows = [entry(3), entry(1), entry(2)];
    expect(selectEntries(rows, 0).map((item) => item.seq)).toEqual([1, 2, 3]);
  });
});

describe("buildExtractionPrompt", () => {
  test("names the project and the turn count", () => {
    const prompt = buildExtractionPrompt([entry(1)], "qronos-cli");
    expect(prompt).toContain("Project: qronos-cli");
    expect(prompt).toContain("Turns: 1");
  });

  test("includes each row's text", () => {
    const prompt = buildExtractionPrompt([entry(1, { prompt: "do a thing", answer: "did it" })], "app");
    expect(prompt).toContain("user: do a thing");
    expect(prompt).toContain("agent: did it");
  });

  test("asks for the JSON object explicitly", () => {
    expect(buildExtractionPrompt([entry(1)], "app")).toContain("Return the JSON object now.");
  });
});

describe("EXTRACTION_SYSTEM_PROMPT", () => {
  test("names all five buckets", () => {
    for (const word of ["decisions", "constraints", "workflows", "failures", "preferences"]) {
      expect(EXTRACTION_SYSTEM_PROMPT).toContain(word);
    }
  });

  test("forbids storing anything about keys or passwords", () => {
    expect(EXTRACTION_SYSTEM_PROMPT).toContain("API keys or passwords");
  });

  test("tells the model that an empty answer is allowed", () => {
    expect(EXTRACTION_SYSTEM_PROMPT).toContain("all-empty answer is a valid answer");
  });
});

describe("parseExtraction", () => {
  test("a clean answer is parsed into sections", () => {
    const result = parseExtraction(
      JSON.stringify({ decisions: ["We chose bun because it is faster"], constraints: [], workflows: [], failures: [], preferences: [] }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.memory.decisions).toEqual(["We chose bun because it is faster"]);
  });

  test("a fenced code block is still parsed", () => {
    const result = parseExtraction('```json\n{"decisions": ["A real decision made here"]}\n```');
    expect(result.ok).toBe(true);
  });

  test("an empty answer fails cleanly", () => {
    const result = parseExtraction("");
    expect(result.ok).toBe(false);
  });

  test("prose with no JSON fails cleanly", () => {
    const result = parseExtraction("I could not find anything worth remembering.");
    expect(result.ok).toBe(false);
  });

  test("an array instead of an object fails cleanly", () => {
    expect(parseExtraction("[]").ok).toBe(false);
  });

  test("an object with none of the five sections fails cleanly", () => {
    expect(parseExtraction('{"notes": ["x"]}').ok).toBe(false);
  });

  test("items that are too short are dropped", () => {
    const result = parseExtraction(JSON.stringify({ decisions: ["ok", "this one is long enough to keep"] }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.memory.decisions).toEqual(["this one is long enough to keep"]);
  });

  test("a secret-looking item is dropped, not stored", () => {
    const result = parseExtraction(JSON.stringify({ constraints: ["the key AKIAIOSFODNN7EXAMPLE must stay secret"] }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.memory.constraints ?? []).toEqual([]);
  });

  test("a long item is clamped", () => {
    const long = "x".repeat(MAX_ITEM_CHARS + 100);
    const result = parseExtraction(JSON.stringify({ decisions: [long] }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.memory.decisions![0]!.length).toBeLessThanOrEqual(MAX_ITEM_CHARS);
  });

  test("objects with a text field are accepted", () => {
    const result = parseExtraction(JSON.stringify({ decisions: [{ text: "a decision stated as an object" }] }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.memory.decisions).toEqual(["a decision stated as an object"]);
  });

  test("a bare string instead of an array is accepted", () => {
    const result = parseExtraction(JSON.stringify({ decisions: "one single decision that is long enough" }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.memory.decisions).toHaveLength(1);
  });

  test("duplicates are folded", () => {
    const result = parseExtraction(
      JSON.stringify({ decisions: ["Use bun for scripts", "use bun for scripts"] }),
    );
    if (result.ok) expect(result.memory.decisions).toHaveLength(1);
  });

  test("the dropped counter reports what was thrown away", () => {
    const result = parseExtraction(JSON.stringify({ decisions: ["too short", "x".repeat(50)], constraints: [5, null] }));
    if (result.ok) expect(result.dropped).toBeGreaterThanOrEqual(3);
  });

  test("MIN_ITEM_CHARS is the boundary the parser uses", () => {
    const justTooShort = "y".repeat(MIN_ITEM_CHARS - 1);
    const result = parseExtraction(JSON.stringify({ decisions: [justTooShort] }));
    if (result.ok) expect(result.memory.decisions ?? []).toEqual([]);
  });
});

describe("isEmptyExtraction", () => {
  test("true when every section is empty or missing", () => {
    expect(isEmptyExtraction({})).toBe(true);
    expect(isEmptyExtraction({ decisions: [] })).toBe(true);
  });

  test("false with one item", () => {
    expect(isEmptyExtraction({ decisions: ["a real decision"] })).toBe(false);
  });
});
