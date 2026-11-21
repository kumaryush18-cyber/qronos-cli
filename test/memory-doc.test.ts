import { describe, expect, test } from "bun:test";
import {
  EMPTY_DOC,
  MAX_ITEM_CHARS,
  SECTION_CAPS,
  SECTION_ORDER,
  SECTION_TITLES,
  capItems,
  docHighlights,
  docItemCount,
  itemKey,
  mergeDoc,
  normalizeItem,
  parseDoc,
  renderDoc,
  sectionOfHeading,
  type MemoryDoc,
} from "../src/memory-doc";

function docWith(sections: Partial<MemoryDoc["sections"]>, extra = ""): MemoryDoc {
  return {
    sections: { decisions: [], constraints: [], workflows: [], failures: [], preferences: [], ...sections },
    extra,
  };
}

describe("parseDoc", () => {
  test("an empty file is the empty document", () => {
    expect(parseDoc("")).toEqual(EMPTY_DOC);
    expect(parseDoc(undefined)).toEqual(EMPTY_DOC);
  });

  test("bullets land in the right section", () => {
    const doc = parseDoc(["# Memory", "", "## Decisions", "- use bun", "", "## Constraints", "- node 20 only"].join("\n"));
    expect(doc.sections.decisions).toEqual(["use bun"]);
    expect(doc.sections.constraints).toEqual(["node 20 only"]);
  });

  test("unknown headings and prose are preserved in extra", () => {
    const doc = parseDoc("# Memory\n\n## Notes\nhand written line\n\n## Decisions\n- a real decision");
    expect(doc.extra).toContain("## Notes");
    expect(doc.extra).toContain("hand written line");
    expect(doc.sections.decisions).toEqual(["a real decision"]);
  });

  test("a bullet before any heading is kept as extra, not lost", () => {
    const doc = parseDoc("# Memory\n- loose bullet\n## Decisions\n- real");
    expect(doc.extra).toContain("loose bullet");
    expect(doc.sections.decisions).toEqual(["real"]);
  });

  test("asterisk bullets are accepted", () => {
    expect(parseDoc("## Decisions\n* star bullet").sections.decisions).toEqual(["star bullet"]);
  });

  test("items past the section cap are dropped", () => {
    const lines = ["## Decisions", ...Array.from({ length: SECTION_CAPS.decisions + 5 }, (_, i) => `- d${i}`)];
    expect(parseDoc(lines.join("\n")).sections.decisions.length).toBe(SECTION_CAPS.decisions);
  });

  test("duplicates inside a section are folded", () => {
    expect(parseDoc("## Decisions\n- same\n- Same").sections.decisions).toEqual(["same"]);
  });
});

describe("sectionOfHeading", () => {
  test("recognises the five titles", () => {
    for (const section of SECTION_ORDER) {
      expect(sectionOfHeading(SECTION_TITLES[section])).toBe(section);
    }
  });

  test("recognises singular aliases a human might type", () => {
    expect(sectionOfHeading("Decision")).toBe("decisions");
    expect(sectionOfHeading("constraint")).toBe("constraints");
  });

  test("returns undefined for a foreign heading", () => {
    expect(sectionOfHeading("Random")).toBeUndefined();
  });
});

describe("normalizeItem and itemKey", () => {
  test("collapses whitespace and trims", () => {
    expect(normalizeItem("  a   b \n c ")).toBe("a b c");
  });

  test("clamps a very long item", () => {
    const long = "x".repeat(MAX_ITEM_CHARS + 50);
    const out = normalizeItem(long);
    expect(out.length).toBeLessThanOrEqual(MAX_ITEM_CHARS);
    expect(out.endsWith("…")).toBe(true);
  });

  test("itemKey ignores case and a trailing full stop", () => {
    expect(itemKey("Use Bun.")).toBe(itemKey("use bun"));
  });
});

describe("mergeDoc", () => {
  test("new items go to the front", () => {
    const merged = mergeDoc(docWith({ decisions: ["old"] }), { decisions: ["new"] });
    expect(merged.sections.decisions).toEqual(["new", "old"]);
  });

  test("a duplicate is not added twice", () => {
    const merged = mergeDoc(docWith({ decisions: ["use bun"] }), { decisions: ["Use Bun."] });
    expect(merged.sections.decisions).toEqual(["use bun"]);
  });

  test("an empty incoming set returns the same document object", () => {
    const doc = docWith({ decisions: ["keep"] });
    expect(mergeDoc(doc, {})).toBe(doc);
  });

  test("a section cap holds when many items arrive", () => {
    const many = Array.from({ length: 30 }, (_, i) => `item ${i}`);
    const merged = mergeDoc(EMPTY_DOC, { decisions: many });
    expect(merged.sections.decisions.length).toBe(SECTION_CAPS.decisions);
  });

  test("extra content survives a merge", () => {
    const doc = docWith({ decisions: ["a"] }, "## Notes\nhand written");
    expect(mergeDoc(doc, { decisions: ["b"] }).extra).toContain("hand written");
  });

  test("the input document is not mutated", () => {
    const doc = docWith({ decisions: ["a"] });
    mergeDoc(doc, { decisions: ["b"] });
    expect(doc.sections.decisions).toEqual(["a"]);
  });
});

describe("renderDoc", () => {
  test("empty sections are not rendered", () => {
    const text = renderDoc(docWith({ decisions: ["one"] }));
    expect(text).toContain("## Decisions");
    expect(text).not.toContain("## Constraints");
  });

  test("an empty document says so", () => {
    expect(renderDoc(EMPTY_DOC)).toContain("Nothing learned yet");
  });

  test("an update timestamp is rendered when given", () => {
    expect(renderDoc(EMPTY_DOC, Date.parse("2026-01-02T03:04:05Z"))).toContain("2026-01-02");
  });

  test("render then parse round-trips", () => {
    const doc = docWith({ decisions: ["a"], failures: ["b"] });
    const back = parseDoc(renderDoc(doc));
    expect(back.sections.decisions).toEqual(["a"]);
    expect(back.sections.failures).toEqual(["b"]);
  });
});

describe("counts and highlights", () => {
  test("docItemCount adds every section", () => {
    expect(docItemCount(docWith({ decisions: ["a", "b"], workflows: ["c"] }))).toBe(3);
  });

  test("docHighlights shows at most three per section", () => {
    const lines = docHighlights(docWith({ decisions: ["a", "b", "c", "d"] }), 3);
    expect(lines[0]).toBe("Decisions: a · b · c");
  });

  test("docHighlights skips empty sections", () => {
    expect(docHighlights(EMPTY_DOC)).toEqual([]);
  });

  test("capItems keeps order and drops blanks", () => {
    expect(capItems(["a", " ", "b"], 5)).toEqual(["a", "b"]);
  });
});
