// Hashline tags: the short fingerprint a patch quotes instead of retyping lines.
//
// Why a tag at all. A patch says "replace lines 42-44" and the file may have
// changed since the model read it. Line numbers alone would silently corrupt the
// file in that case. The tag is a hash of the whole file at read time, so one
// string comparison proves "nothing changed since you looked".
//
// Ported from can1357/oh-my-pi (packages/coding-agent/src/edit/store.ts), which
// mints tags inside a Rust crate we cannot reuse. Behaviour here is the same:
// 4 hex characters, recorded when a file is shown to the model.
import { createHash } from "node:crypto";

/** 4 hex characters, as in `[src/api/users.ts#a3f1]`. */
export function fileTag(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex").slice(0, 4);
}

/** What the model was allowed to see, and the file state it saw. */
export interface SeenFile {
  tag: string;
  /** 1-based first line number shown. */
  firstLine: number;
  /** How many lines were shown. */
  lineCount: number;
  /** Total lines in the file when it was read. */
  totalLines: number;
}

export type TagCheck =
  | { ok: true; seen: SeenFile }
  | { ok: false; reason: "unseen" | "stale"; expected?: string; actual?: string };

/**
 * Session memory of reads. One instance per session, never global: a resumed
 * session must re-read instead of trusting a tag from an earlier run.
 */
export class TagStore {
  private readonly seen = new Map<string, SeenFile>();

  /** Called after a read is shown to the model. Overwrites an earlier window. */
  record(path: string, content: string, firstLine: number, lineCount: number): SeenFile {
    const entry: SeenFile = {
      tag: fileTag(content),
      firstLine,
      lineCount,
      totalLines: countLines(content),
    };
    this.seen.set(normalizePath(path), entry);
    return entry;
  }

  /** Called after a successful write, so the next patch can use the new tag. */
  recordAfterWrite(path: string, content: string): SeenFile {
    return this.record(path, content, 1, countLines(content));
  }

  get(path: string): SeenFile | undefined {
    return this.seen.get(normalizePath(path));
  }

  clear(): void {
    this.seen.clear();
  }

  /**
   * Verify a patch's tag against the file on disk. Two distinct outcomes are
   * reported, because the fix the model should make is different:
   *   unseen -> "read it first"
   *   stale  -> "the file changed, read it again"
   */
  check(path: string, tag: string, currentContent: string): TagCheck {
    const seen = this.get(path);
    if (!seen) return { ok: false, reason: "unseen" };
    const actual = fileTag(currentContent);
    if (seen.tag !== tag || actual !== tag) {
      return { ok: false, reason: "stale", expected: seen.tag, actual };
    }
    return { ok: true, seen };
  }
}

/** Strip `./` and unify separators so `./a.ts` and `a.ts` are one entry. */
export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

export function countLines(content: string): number {
  if (content.length === 0) return 0;
  let lines = 0;
  for (let index = 0; index < content.length; index++) {
    if (content[index] === "\n") lines++;
  }
  return content.endsWith("\n") ? lines : lines + 1;
}

/**
 * Add `NNN| ` prefixes so the model can address lines. Width follows the file,
 * so a 12-line file gets 3-char numbers and a 4000-line file gets 5-char ones.
 */
export function numberLines(text: string, firstLine = 1): string {
  if (text.length === 0) return text;
  const lines = text.split("\n");
  const width = String(firstLine + lines.length - 1).length;
  return lines
    .map((line, index) => `${String(firstLine + index).padStart(width, " ")}| ${line}`)
    .join("\n");
}

/** Header the model sees at the top of every numbered read. */
export function tagHeader(path: string, tag: string, seen: SeenFile): string {
  const range =
    seen.lineCount >= seen.totalLines ? `${seen.totalLines} lines` : `lines ${seen.firstLine}-${seen.firstLine + seen.lineCount - 1} of ${seen.totalLines}`;
  return `[${normalizePath(path)}#${tag}] (${range})`;
}
