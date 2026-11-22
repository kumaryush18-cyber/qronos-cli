// Open a piece of text in the user's editor, and give back what came out.
//
// `ctrl+g` on a card means "$EDITOR": the user's own program, run once, with a
// path we created. No shell string ever comes from the model, and the temp file
// is removed whatever happens.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export interface EditTextOptions {
  /** The file name inside the temp directory, so the editor picks a mode. */
  fileName?: string;
}

/**
 * Edit `text` and return the new text, or `undefined` when nothing changed —
 * including "no editor", "the editor failed" and "the user wrote the same thing".
 * A caller treats `undefined` as "keep what you had", which is always safe.
 */
export function editTextInEditor(text: string, options: EditTextOptions = {}): string | undefined {
  const editor = process.env.VISUAL || process.env.EDITOR;
  if (!editor) return undefined;
  let dir: string | undefined;
  try {
    dir = mkdtempSync(join(tmpdir(), "qronos-edit-"));
    const file = join(dir, options.fileName ?? "text.txt");
    writeFileSync(file, text, "utf8");
    const parts = editor.split(/\s+/).filter(Boolean);
    const result = spawnSync(parts[0]!, [...parts.slice(1), file], { stdio: "inherit" });
    if (result.error || result.status !== 0) return undefined;
    const updated = readFileSync(file, "utf8");
    return updated.trim() === text.trim() ? undefined : updated;
  } catch {
    return undefined;
  } finally {
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // a temp file left behind is not worth an error
      }
    }
  }
}
