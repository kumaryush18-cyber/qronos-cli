// Turning an LSP WorkspaceEdit into file content.
//
// A rename reply is a list of text edits per file, each addressed by (line,
// character). Applying them requires two conversions, and both are easy to get
// subtly wrong:
//   uri -> file path          (file:///c%3A/... on Windows)
//   (line, character) -> JS string offset   (LSP counts UTF-16 code units,
//                                           which is exactly JS string indexing)
// Pure functions, so the whole step is testable without a language server.
import { pathToFileURL, fileURLToPath } from "node:url";

export interface Position {
  line: number;
  character: number;
}

export interface TextEdit {
  range: { start: Position; end: Position };
  newText: string;
}

export interface WorkspaceEdit {
  changes?: Record<string, TextEdit[]>;
  documentChanges?: unknown[];
}

export function uriToPath(uri: string): string {
  try {
    return fileURLToPath(uri);
  } catch {
    return uri.replace(/^file:\/\//, "");
  }
}

export function pathToUri(path: string): string {
  return pathToFileURL(path).href;
}

/** Both shapes LSP allows: `changes` and `documentChanges[].edits`. */
export function collectEdits(edit: WorkspaceEdit | undefined | null): Map<string, TextEdit[]> {
  const out = new Map<string, TextEdit[]>();
  const add = (uri: string, edits: TextEdit[]) => {
    const existing = out.get(uri) ?? [];
    out.set(uri, [...existing, ...edits]);
  };

  for (const [uri, edits] of Object.entries(edit?.changes ?? {})) {
    if (Array.isArray(edits)) add(uri, edits);
  }
  for (const change of edit?.documentChanges ?? []) {
    const typed = change as { textDocument?: { uri?: string }; edits?: TextEdit[] };
    if (typed.textDocument?.uri && Array.isArray(typed.edits)) add(typed.textDocument.uri, typed.edits);
  }
  return out;
}

/** Offset of (line, character) in a JS string; clamped so a bad position cannot throw. */
export function positionToOffset(text: string, position: Position): number {
  const line = Math.max(0, position.line);
  let offset = 0;
  for (let index = 0; index < line; index++) {
    const next = text.indexOf("\n", offset);
    if (next === -1) return text.length;
    offset = next + 1;
  }
  const lineEnd = text.indexOf("\n", offset);
  const end = lineEnd === -1 ? text.length : lineEnd;
  // A position may point at the very end of the line (before \r\n).
  const character = Math.max(0, position.character);
  return Math.min(offset + character, end);
}

/**
 * Apply edits to one file. Edits are applied back-to-front so earlier offsets
 * stay valid, and identical ranges are collapsed (servers sometimes echo an
 * edit twice after a rename).
 */
export function applyTextEdits(text: string, edits: readonly TextEdit[]): string {
  const withOffsets = edits.map((edit) => {
    const start = positionToOffset(text, edit.range.start);
    const end = Math.max(start, positionToOffset(text, edit.range.end));
    return { start, end, newText: edit.newText };
  });

  const seen = new Set<string>();
  const unique = withOffsets.filter((edit) => {
    const key = `${edit.start}:${edit.end}:${edit.newText}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  unique.sort((a, b) => b.start - a.start || b.end - a.end);

  let result = text;
  let lastStart = Number.MAX_SAFE_INTEGER;
  for (const edit of unique) {
    // Overlapping edits would corrupt the file; the later (higher) one wins.
    if (edit.end > lastStart) continue;
    result = result.slice(0, edit.start) + edit.newText + result.slice(edit.end);
    lastStart = edit.start;
  }
  return result;
}
