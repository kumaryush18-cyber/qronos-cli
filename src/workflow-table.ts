// The table a finished run ends with, built from the data the agents produced.
//
// Why a table and not prose: a fan-out answers the same questions about N things
// — one per project, per file, per route. Prose makes the reader compare five
// paragraphs by eye. Claude Code ends such a run with a table, and it is right:
// the shape of the answer is the point.
//
// Rules this keeps:
//   - It only appears when there is something structured to show. Two agents
//     that returned a sentence each are not a table.
//   - Nothing is invented. Every cell is a value some agent really returned.
//   - A cell never breaks the line: it is cut, and the cut is visible.
import type { WorkflowAgentRecord } from "./workflow-types";

/** How many columns a table may have, including the agent column. */
export const MAX_TABLE_COLUMNS = 6;
/** A cell wider than this is cut; a screen is not a spreadsheet. */
export const MAX_CELL_WIDTH = 28;
/** At least this many agents must carry data before a table is worth drawing. */
export const MIN_TABLE_ROWS = 2;

export interface ResultTable {
  columns: string[];
  rows: string[][];
}

/** A value as one short line of text. */
export function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return oneLine(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return oneLine(value.map((item) => cellText(item)).filter((item) => item !== "").join(", "));
  }
  try {
    return oneLine(JSON.stringify(value) ?? "");
  } catch {
    return "";
  }
}

/** Whitespace collapsed, so one cell is always one row. */
function oneLine(text: string): string {
  return String(text).replace(/\s+/g, " ").trim();
}

/**
 * Build the table, or nothing.
 *
 * Columns are the keys the agents agreed on, in the order they were first seen.
 * A key only one agent used is still a column — a gap says "this one did not
 * answer that", which is information, and a missing column would silently hide
 * it.
 */
export function buildResultTable(agents: readonly WorkflowAgentRecord[], options: { maxColumns?: number } = {}): ResultTable | undefined {
  const maxColumns = Math.max(2, options.maxColumns ?? MAX_TABLE_COLUMNS);
  const usable: { label: string; data: Record<string, unknown> }[] = [];
  for (const agent of agents) {
    if (!agent.ok) continue;
    const data = agent.data;
    if (data === null || typeof data !== "object" || Array.isArray(data)) continue;
    usable.push({ label: agent.label, data: data as Record<string, unknown> });
  }
  if (usable.length < MIN_TABLE_ROWS) return undefined;

  const keys: string[] = [];
  for (const row of usable) {
    for (const key of Object.keys(row.data)) {
      if (!keys.includes(key)) keys.push(key);
    }
  }
  const valueKeys = keys.filter((key) => usable.some((row) => cellText(row.data[key]) !== ""));
  if (valueKeys.length === 0) return undefined;

  const head = ["#", ...valueKeys.slice(0, maxColumns - 1)];
  const rows = usable.map((row) => [row.label, ...valueKeys.slice(0, maxColumns - 1).map((key) => cellText(row.data[key]))]);
  return { columns: head, rows };
}

/**
 * Draw the table as plain text, padded so the columns line up.
 *
 * Every value column is as wide as its widest cell, capped: a 200-character
 * description would otherwise push the last column off the screen.
 */
export function renderResultTable(table: ResultTable, options: { maxCellWidth?: number } = {}): string[] {
  const maxCellWidth = Math.max(6, options.maxCellWidth ?? MAX_CELL_WIDTH);
  const widths = table.columns.map((column, index) => {
    const cells = [column, ...table.rows.map((row) => row[index] ?? "")];
    const widest = Math.max(...cells.map((cell) => cut(cell, maxCellWidth).length));
    return Math.max(1, widest);
  });

  const line = (cells: string[]): string =>
    cells
      .map((cell, index) => {
        const text = cut(cell, maxCellWidth);
        // The last column is not padded: trailing spaces in a chat line are
        // noise, and a markdown table does not need them.
        return index === cells.length - 1 ? text : text.padEnd(widths[index]!);
      })
      .join(" │ ")
      .trimEnd();

  const out = [line(table.columns)];
  out.push(widths.map((width) => "─".repeat(width)).join("─┼─"));
  for (const row of table.rows) out.push(line(row));
  return out;
}

/** Cut a cell, with a visible mark that it was cut. */
function cut(text: string, width: number): string {
  const clean = oneLine(text);
  if (clean.length <= width) return clean;
  return `${clean.slice(0, Math.max(0, width - 1))}…`;
}

/**
 * The whole section, ready to append to a report: a heading, then the table.
 * Empty when there is nothing structured to show.
 */
export function resultTableSection(agents: readonly WorkflowAgentRecord[]): string[] {
  const table = buildResultTable(agents);
  if (!table) return [];
  return ["", "results:", ...renderResultTable(table)];
}
