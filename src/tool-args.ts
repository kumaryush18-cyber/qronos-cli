// Extract file paths out of tool arguments.
//
// Tools disagree about the name of the "path" argument (`path`, `file_path`,
// `files`, a hashline `patch` header), so the mapping lives in one place and
// both memory and compaction use it.

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

/** Every file path named by a tool call's arguments. Never throws. */
export function toolFileArgs(args: unknown): string[] {
  if (!args || typeof args !== "object") return [];
  const record = args as Record<string, unknown>;
  const out: string[] = [];
  for (const key of ["path", "file_path", "filePath", "filename", "file", "notebook_path", "target"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") out.push(value);
  }
  for (const key of ["paths", "files"]) {
    const value = record[key];
    if (Array.isArray(value)) {
      for (const item of value) if (typeof item === "string" && item.trim() !== "") out.push(item);
    }
  }
  // hashline's apply_patch carries `[path#tag]` headers instead of a path arg.
  const patch = record.patch ?? record.input;
  if (typeof patch === "string") {
    for (const match of patch.matchAll(/^\[([^\]\n#]+)#[0-9a-fA-F]+\]/gm)) {
      const file = match[1]?.trim();
      if (file) out.push(file);
    }
  }
  return out;
}
