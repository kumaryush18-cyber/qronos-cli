// The curated memory document: five buckets of durable project knowledge.
//
// Why a fixed five-bucket shape instead of free prose: the model that reads the
// summary at session start has no time to parse an essay, and a merged document
// with stable headings is diffable, testable and cheap to cap. Anything the
// user or the agent writes that is NOT one of the five handled headings is kept
// verbatim at the end of the file, so a hand edit is never silently deleted by
// the next sync.
export type MemorySection = "decisions" | "constraints" | "workflows" | "failures" | "preferences";

export const SECTION_ORDER: readonly MemorySection[] = [
  "decisions",
  "constraints",
  "workflows",
  "failures",
  "preferences",
];

export const SECTION_TITLES: Record<MemorySection, string> = {
  decisions: "Decisions",
  constraints: "Constraints",
  workflows: "Workflows",
  failures: "Failures fixed",
  preferences: "Preferences",
};

/** Items kept per section. Small on purpose: a summary nobody reads is waste. */
export const SECTION_CAPS: Record<MemorySection, number> = {
  decisions: 12,
  constraints: 10,
  workflows: 8,
  failures: 10,
  preferences: 8,
};

/** Longest single item, so one giant paragraph cannot crowd out the rest. */
export const MAX_ITEM_CHARS = 220;

export interface MemoryDoc {
  sections: Record<MemorySection, string[]>;
  /** Markdown that is not one of our headings; preserved as-is. */
  extra: string;
}

export const EMPTY_DOC: MemoryDoc = {
  sections: { decisions: [], constraints: [], workflows: [], failures: [], preferences: [] },
  extra: "",
};

const HEADING = /^##\s+(.+?)\s*$/;
const BULLET = /^\s*[-*]\s+(.*)$/;

/** Map a heading's text to a section, or undefined when it is not ours. */
export function sectionOfHeading(heading: string): MemorySection | undefined {
  const wanted = heading.trim().toLowerCase();
  for (const section of SECTION_ORDER) {
    if (SECTION_TITLES[section].toLowerCase() === wanted) return section;
  }
  // Tolerate the common aliases a person might type by hand.
  const aliases: Record<string, MemorySection> = {
    decision: "decisions",
    constraint: "constraints",
    workflow: "workflows",
    failure: "failures",
    "failure fixed": "failures",
    preference: "preferences",
    "what worked": "workflows",
    "gotchas": "constraints",
  };
  return aliases[wanted];
}

/**
 * Parse the document. Tolerant by design: unknown headings and prose are kept
 * in `extra` (minus the leading `# Memory` title), so a human edit survives.
 */
export function parseDoc(markdown: string | undefined): MemoryDoc {
  if (!markdown || markdown.trim() === "") {
    return { sections: { ...EMPTY_DOC.sections }, extra: "" };
  }
  const sections: Record<MemorySection, string[]> = {
    decisions: [],
    constraints: [],
    workflows: [],
    failures: [],
    preferences: [],
  };
  let current: MemorySection | undefined;
  const extras: string[] = [];
  for (const rawLine of markdown.split("\n")) {
    const line = rawLine.replace(/\s+$/, "");
    const heading = HEADING.exec(line);
    if (heading) {
      current = sectionOfHeading(heading[1] ?? "");
      if (!current) extras.push(line);
      continue;
    }
    // A top-level `# ...` title is ours, not user content.
    if (/^#\s+/.test(line)) continue;
    const bullet = BULLET.exec(line);
    if (bullet && current) {
      const text = normalizeItem(bullet[1] ?? "");
      if (text !== "") sections[current].push(text);
      continue;
    }
    if (line.trim() === "" || current) {
      // Blank line inside a section: ignore. Non-bullet text inside a section
      // is not something we generate, so keep it with the extras.
      if (line.trim() !== "" && current) extras.push(line);
      continue;
    }
    extras.push(line);
  }
  for (const section of SECTION_ORDER) sections[section] = capItems(sections[section], SECTION_CAPS[section]);
  return { sections, extra: extras.join("\n").trim() };
}

/** Trim, collapse whitespace and clamp. Used on every path into the document. */
export function normalizeItem(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat === "") return "";
  return flat.length > MAX_ITEM_CHARS ? `${flat.slice(0, MAX_ITEM_CHARS - 1).trimEnd()}…` : flat;
}

/** Case-insensitive identity for deduplication, punctuation-blind. */
export function itemKey(text: string): string {
  return normalizeItem(text)
    .toLowerCase()
    .replace(/[.!;,]+$/g, "")
    .replace(/\s+/g, " ");
}

export function capItems(items: string[], cap: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const text = normalizeItem(item);
    if (text === "") continue;
    const key = itemKey(text);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= cap) break;
  }
  return out;
}

export interface IncomingMemory {
  decisions?: string[];
  constraints?: string[];
  workflows?: string[];
  failures?: string[];
  preferences?: string[];
}

/**
 * Merge new items into the document. Newest first, deduplicated, capped. An
 * empty incoming set returns the document unchanged, so a failed extraction can
 * never erase what is already known.
 */
export function mergeDoc(doc: MemoryDoc, incoming: IncomingMemory): MemoryDoc {
  const sections = { ...doc.sections } as Record<MemorySection, string[]>;
  let changed = false;
  for (const section of SECTION_ORDER) {
    const before = sections[section];
    // An item already known keeps its original wording: re-phrasing the same
    // fact every sync would make the document churn and lose its diff value.
    const known = new Set(before.map(itemKey));
    const additions: string[] = [];
    for (const item of incoming[section] ?? []) {
      const text = normalizeItem(item);
      if (text === "") continue;
      const key = itemKey(text);
      if (known.has(key)) continue;
      known.add(key);
      additions.push(text);
    }
    if (additions.length === 0) continue;
    const merged = capItems([...additions.reverse(), ...before], SECTION_CAPS[section]);
    if (merged.length !== before.length || merged.some((item, i) => item !== before[i])) changed = true;
    sections[section] = merged;
  }
  return changed ? { sections, extra: doc.extra } : doc;
}

/** Render the document as markdown, newest item first inside each section. */
export function renderDoc(doc: MemoryDoc, updatedAt?: number): string {
  const lines: string[] = ["# Memory", ""];
  if (updatedAt && updatedAt > 0) lines.push(`_updated ${new Date(updatedAt).toISOString()}_`, "");
  let wroteSection = false;
  for (const section of SECTION_ORDER) {
    const items = doc.sections[section];
    if (items.length === 0) continue;
    wroteSection = true;
    lines.push(`## ${SECTION_TITLES[section]}`);
    for (const item of items) lines.push(`- ${item}`);
    lines.push("");
  }
  if (!wroteSection) lines.push("_Nothing learned yet._", "");
  if (doc.extra.trim() !== "") lines.push(doc.extra.trim(), "");
  return `${lines.join("\n").trimEnd()}\n`;
}

/** Total items, for `/memory stats`. */
export function docItemCount(doc: MemoryDoc): number {
  return SECTION_ORDER.reduce((sum, section) => sum + doc.sections[section].length, 0);
}

/** Compact one-line-per-section view used by the injected summary. */
export function docHighlights(doc: MemoryDoc, perSection = 3): string[] {
  const lines: string[] = [];
  for (const section of SECTION_ORDER) {
    const items = doc.sections[section];
    if (items.length === 0) continue;
    const shown = items.slice(0, perSection);
    lines.push(`${SECTION_TITLES[section]}: ${shown.join(" · ")}`);
  }
  return lines;
}
