import { describe, expect, test } from "bun:test";
import {
  MAX_CELL_WIDTH,
  MIN_TABLE_ROWS,
  buildResultTable,
  cellText,
  renderResultTable,
  resultTableSection,
} from "../src/workflow-table";
import type { WorkflowAgentRecord } from "../src/workflow-types";

const agent = (label: string, data?: unknown, ok = true): WorkflowAgentRecord => ({
  id: label,
  label,
  ok,
  durationMs: 1,
  depth: 1,
  data,
});

describe("a cell", () => {
  test("a string keeps its words on one line", () => {
    expect(cellText("two\nlines\there")).toBe("two lines here");
  });

  test("numbers and booleans are plain", () => {
    expect(cellText(12)).toBe("12");
    expect(cellText(false)).toBe("false");
  });

  test("nothing becomes an empty cell, not the word null", () => {
    expect(cellText(null)).toBe("");
    expect(cellText(undefined)).toBe("");
  });

  test("a list is joined with commas", () => {
    expect(cellText(["a", "b"])).toBe("a, b");
  });

  test("a nested object becomes one compact line", () => {
    expect(cellText({ a: 1 })).toBe('{"a":1}');
  });
});

describe("building the table", () => {
  test("one agent with data is not a table", () => {
    expect(buildResultTable([agent("one", { a: 1 })])).toBeUndefined();
  });

  test("agents without data are not a table", () => {
    expect(buildResultTable([agent("a"), agent("b")])).toBeUndefined();
  });

  test("a failed agent does not become a row", () => {
    const table = buildResultTable([agent("a", { x: 1 }), agent("b", { x: 2 }), agent("bad", { x: 3 }, false)]);
    expect(table?.rows.map((row) => row[0])).toEqual(["a", "b"]);
  });

  test("two agents that agree make a table with the agent name first", () => {
    const table = buildResultTable([agent("one", { project: "p1", about: "x" }), agent("two", { project: "p2", about: "y" })]);
    expect(table?.columns).toEqual(["#", "project", "about"]);
    expect(table?.rows).toEqual([
      ["one", "p1", "x"],
      ["two", "p2", "y"],
    ]);
  });

  test("a key only one agent used is still a column, with a gap", () => {
    const table = buildResultTable([agent("one", { a: 1, extra: "yes" }), agent("two", { a: 2 })]);
    expect(table?.columns).toContain("extra");
    expect(table?.rows[1]![2]).toBe("");
  });

  test("a key nobody filled is dropped", () => {
    const table = buildResultTable([agent("one", { a: 1, empty: "" }), agent("two", { a: 2 })]);
    expect(table?.columns).toEqual(["#", "a"]);
  });

  test("the number of columns is capped", () => {
    const wide = { a: "1", b: "2", c: "3", d: "4", e: "5", f: "6", g: "7" };
    const table = buildResultTable([agent("one", wide), agent("two", wide)]);
    expect(table!.columns.length).toBeLessThanOrEqual(6);
  });

  test("the minimum is the constant the docs promise", () => {
    const rows = Array.from({ length: MIN_TABLE_ROWS - 1 }, (_, index) => agent(`a${index}`, { x: index }));
    expect(buildResultTable(rows)).toBeUndefined();
  });

  test("data that is a string or a list is not a table", () => {
    expect(buildResultTable([agent("a", "text"), agent("b", "text")])).toBeUndefined();
    expect(buildResultTable([agent("a", [1, 2]), agent("b", [3, 4])])).toBeUndefined();
  });
});

describe("drawing the table", () => {
  const table = () =>
    buildResultTable([
      agent("coding-agent", { project: "coding-agent", about: "the agent loop" }),
      agent("ai-and-tui", { project: "ai-and-tui", about: "providers and the TUI" }),
    ])!;

  test("the header, a rule, then one line per agent", () => {
    const lines = renderResultTable(table());
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain("#");
    expect(lines[1]).toContain("─");
  });

  test("columns line up", () => {
    // The rule under the header is the one line without dividers.
    const rows = renderResultTable(table()).filter((line) => line !== "" && line.includes("│"));
    const dividers = (line: string) => [...line].map((ch, at) => (ch === "│" ? at : -1)).filter((at) => at >= 0);
    expect(rows.length).toBeGreaterThan(1);
    expect(new Set(rows.map((line) => dividers(line).join(","))).size).toBe(1);
  });

  test("a cell is cut and the cut is visible", () => {
    const long = buildResultTable([
      agent("one", { about: "x".repeat(200) }),
      agent("two", { about: "y".repeat(200) }),
    ])!;
    const lines = renderResultTable(long);
    expect(lines[2]!.length).toBeLessThan(lines[0]!.length + MAX_CELL_WIDTH * 2);
    expect(lines[2]).toContain("…");
  });

  test("no line ends with padding", () => {
    for (const line of renderResultTable(table())) {
      expect(line).toBe(line.trimEnd());
    }
  });

  test("the section has a heading and nothing else when there is no table", () => {
    expect(resultTableSection([agent("one", { a: 1 })])).toEqual([]);
  });

  test("the section starts with a blank line and a heading", () => {
    const section = resultTableSection([
      agent("one", { a: 1 }),
      agent("two", { a: 2 }),
    ]);
    expect(section[0]).toBe("");
    expect(section[1]).toBe("results:");
    expect(section.length).toBeGreaterThan(3);
  });
});
