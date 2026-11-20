// Parser for the hashline patch format.
//
// Format (copied from can1357/oh-my-pi, packages/coding-agent/src/edit/hashline-compact.md):
//
//   *** Begin Patch
//   [src/api/users.ts#a3f1]
//   PUT 42.=44:
//   +export async function loadUser(
//   +  id: string,
//   +): Promise<User> {
//   *** End Patch
//
// The model sends ONLY the lines that change. Everything else stays on disk,
// which is where the token saving comes from.
//
// Supported ops (a deliberate subset of oh-my-pi):
//   PUT N.=M:   replace lines N..M with the `+` body
//   PUT <N:     insert the body before line N
//   PUT >N:     insert the body after line N
//   PUT >$:     append the body at the end of the file
//   CUT N.=M    delete lines N..M
//   REM         delete the whole file
//   MV DEST     move/rename the file
// Not supported yet, and rejected with a clear message: block ops (`N*`),
// clipboard registers (`@name`), and `PUT >N*`. Better an honest error than a
// half-applied patch.

export type PatchOp =
  | { kind: "replace"; start: number; end: number; body: string[] }
  | { kind: "insert-before"; at: number; body: string[] }
  | { kind: "insert-after"; at: number; body: string[] }
  | { kind: "append"; body: string[] }
  | { kind: "cut"; start: number; end: number }
  | { kind: "remove" }
  | { kind: "move"; destination: string };

export interface PatchSection {
  path: string;
  tag: string;
  ops: PatchOp[];
}

export class PatchParseError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(`patch line ${line}: ${message}`);
    this.name = "PatchParseError";
  }
}

const SECTION_HEADER = /^\[(.+?)#([0-9a-fA-F]{4})\]$/;
const PUT = /^PUT\s+(.+?):$/;
const CUT = /^CUT\s+(\d+)\s*\.=\s*(\d+)$/;
const RANGE = /^(\d+)\s*\.=\s*(\d+)$/;
const BEFORE = /^<(\d+)$/;
const AFTER = /^>(\d+)$/;
const APPEND = /^>\$$/;

/**
 * Parse a patch. Throws PatchParseError with the offending line number, because
 * the model reads the message and fixes the patch instead of guessing.
 */
export function parsePatch(text: string): PatchSection[] {
  const rawLines = text.replace(/\r\n/g, "\n").split("\n");
  const sections: PatchSection[] = [];
  let current: PatchSection | undefined;
  let pendingOp: { kind: "put"; spec: string; line: number } | undefined;
  let body: string[] = [];

  const flushBody = () => {
    if (!pendingOp) return;
    if (!current) throw new PatchParseError("body without a file section", pendingOp.line);
    // PUT always carries new lines; deleting is CUT, so an empty body is a mistake
    // (usually a range that the model forgot to fill in).
    if (body.length === 0) {
      throw new PatchParseError(`PUT ${pendingOp.spec}: has no "+" body lines (use CUT to delete)`, pendingOp.line);
    }
    current.ops.push(buildPut(pendingOp.spec, body, pendingOp.line));
    pendingOp = undefined;
    body = [];
  };

  for (let index = 0; index < rawLines.length; index++) {
    const lineNumber = index + 1;
    const line = rawLines[index];

    if (line === "*** Begin Patch" || line === "*** End Patch" || line.trim() === "") {
      // Blank lines inside a body mean a blank source line is written as a lone
      // "+", never as nothing; outside a body they are noise.
      continue;
    }

    if (line.startsWith("*** ")) {
      throw new PatchParseError(`unknown patch directive "${line}"`, lineNumber);
    }

    if (line.startsWith("[")) {
      flushBody();
      const match = SECTION_HEADER.exec(line.trim());
      if (!match) throw new PatchParseError(`bad file header "${line}" (expected [path#abcd])`, lineNumber);
      current = { path: match[1], tag: match[2].toLowerCase(), ops: [] };
      sections.push(current);
      continue;
    }

    if (line.startsWith("+")) {
      if (!pendingOp) throw new PatchParseError(`body line without PUT: "${line}"`, lineNumber);
      body.push(unescapeBody(line.slice(1)));
      continue;
    }

    flushBody();

    if (!current) throw new PatchParseError(`operations must follow a [path#tag] header`, lineNumber);

    const put = PUT.exec(line.trim());
    if (put) {
      pendingOp = { kind: "put", spec: put[1].trim(), line: lineNumber };
      continue;
    }

    const cut = CUT.exec(line.trim());
    if (cut) {
      current.ops.push(rangeOp("cut", Number(cut[1]), Number(cut[2]), lineNumber));
      continue;
    }

    if (line.trim() === "REM") {
      current.ops.push({ kind: "remove" });
      continue;
    }

    if (line.trim().startsWith("MV ")) {
      const destination = line.trim().slice(3).trim();
      if (!destination) throw new PatchParseError("MV needs a destination path", lineNumber);
      current.ops.push({ kind: "move", destination });
      continue;
    }

    throw new PatchParseError(`unknown operation "${line.trim()}"`, lineNumber);
  }

  flushBody();
  if (sections.length === 0) throw new PatchParseError("patch has no sections", 1);
  for (const section of sections) {
    if (section.ops.length === 0) throw new PatchParseError(`section [${section.path}] has no operations`, 1);
  }
  return sections;
}

function buildPut(spec: string, body: string[], line: number): PatchOp {
  if (spec.includes("*")) {
    throw new PatchParseError("block operations (N*) are not supported yet; use a line range", line);
  }
  if (spec.includes("@")) {
    throw new PatchParseError("clipboard registers (@name) are not supported yet", line);
  }
  const range = RANGE.exec(spec);
  if (range) return rangeOp("replace", Number(range[1]), Number(range[2]), line, body);
  const before = BEFORE.exec(spec);
  if (before) return { kind: "insert-before", at: Number(before[1]), body };
  const after = AFTER.exec(spec);
  if (after) return { kind: "insert-after", at: Number(after[1]), body };
  if (APPEND.test(spec)) return { kind: "append", body };
  throw new PatchParseError(`bad PUT target "${spec}" (use N.=M, <N, >N or >$)`, line);
}

function rangeOp(
  kind: "replace" | "cut",
  start: number,
  end: number,
  line: number,
  body: string[] = [],
): PatchOp {
  if (start < 1) throw new PatchParseError("line numbers are 1-based", line);
  if (end < start) throw new PatchParseError(`range ${start}.=${end} ends before it starts`, line);
  if (kind === "replace") return { kind: "replace", start, end, body };
  return { kind: "cut", start, end };
}

/** `++x` is a literal "+x", `+- x` is a literal "- x", a lone "+" is a blank line. */
export function unescapeBody(text: string): string {
  if (text.startsWith("++")) return text.slice(1);
  if (text.startsWith("+-")) return text.slice(1);
  return text;
}
