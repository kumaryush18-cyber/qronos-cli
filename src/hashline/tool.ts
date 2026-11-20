// The `apply_patch` tool: hashline edits, plus the read hook that mints tags.
//
// Why a new tool and not a change to `edit`: pi's `edit` is exact-text matching
// and the model is already good at it. This tool exists for the case where that
// breaks down — a 400-line file where 3 lines change. The model sends the 3 new
// lines and a line range, not a copy of everything around them.
//
// Both tools stay available (the user asked for that): `edit` for small, exact
// changes, `apply_patch` for multi-line rewrites.
//
// The read hook replaces what the model sees for `read`:
//   [src/api/users.ts#a3f1] (240 lines)
//      1| import ...
//      2| ...
// The tag is a hash of the whole file, so a patch quoting `#a3f1` is refused if
// the file changed after the read.
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionFactory, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { applyOps, splitLines, summarize } from "./apply";
import { parsePatch, PatchParseError, type PatchSection } from "./parse";
import { fileTag, normalizePath, numberLines, tagHeader, TagStore } from "./tag";

export const PATCH_TOOL_NAME = "apply_patch";

/** Refuse absurd files: a patch on a 50 MB log is a mistake, not a request. */
export const MAX_PATCH_FILE_BYTES = 2 * 1024 * 1024;

export const PATCH_PARAMS = Type.Object({
  patch: Type.String({
    description:
      "Hashline patch. Header [path#tag] (tag from the last read), then ops: PUT N.=M:, PUT <N:, PUT >N:, PUT >$:, CUT N.=M, REM, MV dest. Body lines start with '+'.",
  }),
});

export interface PatchToolOptions {
  /** Working directory for relative paths. */
  cwd?: () => string;
  /** Disable the numbering/tag on read (keeps plain pi behaviour). */
  numberReads?: boolean;
}

export function createPatchToolExtension(options: PatchToolOptions = {}): ExtensionFactory {
  return (qronos: ExtensionAPI) => {
    const store = new TagStore();
    const cwd = () => options.cwd?.() ?? process.cwd();
    const numberReads = options.numberReads ?? true;

    // --- read hook: show line numbers and the file's tag -------------------
    if (numberReads) {
      qronos.on("tool_result", async (event) => {
        if (event.toolName !== "read" || event.isError) return;
        const path = typeof event.input?.path === "string" ? event.input.path : undefined;
        if (!path) return;
        const block = event.content.find((item) => item.type === "text");
        if (!block || block.type !== "text") return;
        // Images and truncation notices are left exactly as pi produced them.
        const text = block.text;
        if (!text || text.startsWith("[")) return;

        const absolute = resolvePath(cwd(), path);
        let full: string;
        try {
          full = readFileSync(absolute, "utf8");
        } catch {
          return;
        }
        const offset = typeof event.input?.offset === "number" ? Math.max(1, event.input.offset) : 1;
        const limit = typeof event.input?.limit === "number" ? event.input.limit : undefined;
        const allLines = full.length === 0 ? [] : full.split("\n");
        // The visible block may be shorter than the request because of pi's own
        // truncation; number only what is actually on screen.
        const shownCount = text.split("\n").filter((line, index, all) => !(index === all.length - 1 && line === "")).length;
        const lineCount = limit === undefined ? Math.min(shownCount, allLines.length - (offset - 1)) : Math.min(limit, shownCount);

        const seen = store.record(path, full, offset, lineCount);
        const numbered = numberLines(text.replace(/\n$/, ""), offset);
        const replaced = [{ type: "text" as const, text: `${tagHeader(path, seen.tag, seen)}\n${numbered}\n` }, ...event.content.slice(1)];
        return { content: replaced };
      });
    }

    // --- the tool ----------------------------------------------------------
    qronos.registerTool({
      name: PATCH_TOOL_NAME,
      label: "Apply patch",
      description:
        "Edit files by line range using a hashline patch. Cheaper than `edit` for multi-line rewrites: you send only the changed lines.",
      promptSnippet:
        "Edit by line range from a tagged read: [path#tag] then PUT N.=M: / PUT <N: / PUT >N: / PUT >$: / CUT N.=M / REM / MV dest",
      promptGuidelines: [
        "Read a file before patching it: the tag in [path#tag] proves the file has not changed since.",
        "Re-read after a successful patch; the tag and the line numbers change.",
        "Use `edit` for a one-line change and `apply_patch` when several lines change at once.",
      ],
      parameters: PATCH_PARAMS,
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        return runPatch(params.patch, { store, cwd, ctx });
      },
    });
  };
}

export interface RunPatchDeps {
  store: TagStore;
  cwd: () => string;
  ctx?: ExtensionToolContext;
  /** Test seam: write through the real `write` tool when available. */
  writeFile?: (absolutePath: string, content: string) => Promise<void>;
}

export interface ToolOutcome {
  content: { type: "text"; text: string }[];
  details: undefined;
  isError: boolean;
}

export async function runPatch(patch: string, deps: RunPatchDeps): Promise<ToolOutcome> {
  const text = (value: string) => ({
  content: [{ type: "text" as const, text: value }],
  details: undefined,
  isError: false,
});
  const fail = (value: string) => ({
  content: [{ type: "text" as const, text: `Error: ${value}` }],
  details: undefined,
  isError: true,
});

  let sections: PatchSection[];
  try {
    sections = parsePatch(patch);
  } catch (error) {
    if (error instanceof PatchParseError) return fail(error.message);
    return fail(`could not parse the patch: ${(error as Error).message}`);
  }

  const lines: string[] = [];

  for (const section of sections) {
    const absolute = resolvePath(deps.cwd(), section.path);
    const hasFile = existsSync(absolute);

    for (const op of section.ops) {
      if (op.kind === "remove") {
        if (!hasFile) return fail(`[${section.path}] does not exist, nothing to REM`);
        unlinkSync(absolute);
        lines.push(`removed ${normalizePath(section.path)}`);
        break;
      }
      if (op.kind === "move") {
        const target = resolvePath(deps.cwd(), op.destination);
        if (!hasFile) return fail(`[${section.path}] does not exist, nothing to MV`);
        mkdirSync(dirname(target), { recursive: true });
        renameSync(absolute, target);
        deps.store.recordAfterWrite(op.destination, readFileSync(target, "utf8"));
        lines.push(`moved ${normalizePath(section.path)} -> ${normalizePath(op.destination)}`);
        break;
      }
    }

    const structural = section.ops.some((op) => op.kind === "remove" || op.kind === "move");
    if (structural) continue;

    if (!hasFile) return fail(`[${section.path}] does not exist; use the write tool to create files`);

    const original = readFileSync(absolute, "utf8");
    if (Buffer.byteLength(original, "utf8") > MAX_PATCH_FILE_BYTES) {
      return fail(`[${section.path}] is larger than ${MAX_PATCH_FILE_BYTES} bytes; use the edit tool`);
    }

    const check = deps.store.check(section.path, section.tag, original);
    if (!check.ok) {
      if (check.reason === "unseen") {
        return fail(
          `no read of [${section.path}] in this session. Read the file first, then use the tag it shows.`,
        );
      }
      return fail(
        `[${section.path}] changed since it was read (tag ${section.tag} but the file is now #${check.actual}). Re-read it and patch again.`,
      );
    }

    let applied;
    try {
      applied = applyOps(original, section.ops);
    } catch (error) {
      return fail(`[${section.path}] ${(error as Error).message}`);
    }

    // Nothing changed is almost always a wrong line range; say so instead of
    // reporting success and leaving the model to wonder.
    if (applied.content === original) {
      return fail(`[${section.path}] patch changed nothing; check the line numbers against the last read`);
    }

    try {
      if (deps.writeFile) await deps.writeFile(absolute, applied.content);
      else await writeThroughTool(deps.ctx, absolute, applied.content);
    } catch (error) {
      return fail(`[${section.path}] could not be written: ${(error as Error).message}`);
    }

    const unseen = splitLines(applied.content);
    const seen = deps.store.recordAfterWrite(section.path, applied.content);
    lines.push(
      `${normalizePath(section.path)}: ${summarize(section.ops, applied.changedLines)}; now ${unseen.lines.length} lines, tag #${fileTag(applied.content)}`,
    );
    void seen;
  }

  return text(lines.join("\n"));
}

async function writeThroughTool(ctx: ExtensionToolContext | undefined, absolutePath: string, content: string): Promise<void> {
  if (!ctx) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(absolutePath, content, "utf8");
    return;
  }
  // Going through pi's `write` keeps permissions, hooks and the transcript the
  // same as a model-issued write; a direct fs call would bypass all three.
  const outcome = await ctx.executeTool("write", { path: absolutePath, content });
  if (outcome.isError) {
    throw new Error(summarizeOutcome(outcome) || "the write tool refused the change");
  }
}

function summarizeOutcome(outcome: unknown): string {
  const content = (outcome as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (block && typeof block === "object" && (block as { text?: string }).text) || "")
    .join(" ")
    .slice(0, 300);
}

export function resolvePath(cwd: string, path: string): string {
  return isAbsolute(path) ? path : resolve(join(cwd, path));
}
