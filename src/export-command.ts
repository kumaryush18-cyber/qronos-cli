// `/export` — save the conversation as plain text, or copy it.
//
// Two ways in, exactly like Claude Code:
//   `/export`          asks first: copy to the clipboard, or save to a file
//   `/export notes.txt` skips the question and writes that file
//
// The question is a real menu, so a user who is unsure can press Esc and
// nothing happens. A run that writes a file by accident is worse than one that
// writes nothing.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { copyToClipboard, type CopyResult } from "./export-clipboard";
import { askExportFileName } from "./export-panel";
import {
  buildExportText,
  exportFileName,
  firstUserText,
  freeFileName,
  type ExportEntryLike,
} from "./export-text";

/** The two rows of the menu, in the order Claude Code shows them. */
export const EXPORT_CHOICES = ["Copy to clipboard", "Save to file"] as const;

const NOTHING_TO_EXPORT = "Nothing to export yet — say something first.";

export interface ExportCommandDeps {
  copy?: (text: string) => Promise<CopyResult>;
  now?: () => Date;
  exists?: (path: string) => boolean;
  write?: (path: string, text: string) => void;
  mkdir?: (path: string) => void;
  /** Injected in tests: the save screen, without a terminal. */
  askName?: (ctx: any, initialName: string) => Promise<string | undefined>;
}

function notify(ctx: any, message: string, type: "info" | "warning" | "error" = "info"): void {
  try {
    ctx?.ui?.notify?.(message, type);
  } catch {
    // A notice that cannot be drawn must never throw.
  }
}

/** `~/notes.txt` and `notes.md` both work; a bare name gets `.txt`. */
export function resolveTargetPath(cwd: string, arg: string): string {
  const trimmed = arg.trim().replace(/^["']|["']$/g, "");
  const expanded = trimmed.startsWith("~/") ? join(homedir(), trimmed.slice(2)) : trimmed;
  const full = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
  return basename(full).includes(".") ? full : `${full}.txt`;
}

function lineCount(text: string): number {
  return text.split("\n").filter((line) => line.trim() !== "").length;
}

/** Write the file, and say where it went. Throws only on a real disk error. */
function saveFile(
  cwd: string,
  requested: string,
  text: string,
  deps: ExportCommandDeps,
): { path: string; renamed: boolean } {
  const exists = deps.exists ?? existsSync;
  const write = deps.write ?? ((path: string, body: string) => writeFileSync(path, body, "utf8"));
  const mkdir = deps.mkdir ?? ((path: string) => mkdirSync(path, { recursive: true }));
  const wanted = resolveTargetPath(cwd, requested);
  mkdir(dirname(wanted));
  const finalPath = freeFileName(wanted, exists);
  write(finalPath, text);
  return { path: finalPath, renamed: finalPath !== wanted };
}

/**
 * The command handler.
 *
 * It reads the session, never changes it: an export is a read of what already
 * happened, so it cannot lose work even when it fails.
 */
export async function runExport(
  args: string,
  ctx: any,
  deps: ExportCommandDeps = {},
): Promise<void> {
  const now = deps.now ? deps.now() : new Date();
  const cwd: string = ctx?.cwd ?? ctx?.sessionManager?.getCwd?.() ?? process.cwd();
  const entries: ExportEntryLike[] = ctx?.sessionManager?.getBranch?.() ?? [];
  const hasMessage = entries.some((entry) => entry?.type === "message");
  if (!hasMessage) {
    notify(ctx, NOTHING_TO_EXPORT, "warning");
    return;
  }

  const text = buildExportText({
    entries,
    cwd,
    model: ctx?.model?.id,
    title: ctx?.sessionManager?.getSessionName?.(),
    now,
  });

  const requested = args.trim();
  if (requested !== "") {
    try {
      const saved = saveFile(cwd, requested, text, deps);
      notify(
        ctx,
        `Saved ${saved.path}${saved.renamed ? " (the name was taken, so a number was added)" : ""} · ${lineCount(text)} lines`,
      );
    } catch (error) {
      notify(ctx, `Could not save the export: ${(error as Error).message}`, "error");
    }
    return;
  }

  // No argument: ask, with a menu. A host without a UI gets instructions.
  if (typeof ctx?.ui?.select !== "function") {
    notify(ctx, "Use /export <file> to save this conversation as plain text.", "info");
    return;
  }
  const choice = await ctx.ui.select("Export conversation", [...EXPORT_CHOICES]);
  if (!choice) return;

  if (choice === EXPORT_CHOICES[0]) {
    const copy = deps.copy ?? ((body: string) => copyToClipboard(body));
    const result = await copy(text);
    if (result.ok) notify(ctx, `Copied the conversation to the clipboard · ${lineCount(text)} lines`);
    else notify(ctx, "Could not reach the clipboard. Try /export <file> to save instead.", "warning");
    return;
  }

  const suggested = exportFileName(now, firstUserText(entries));
  const askName = deps.askName ?? ((host: any, name: string) => askExportFileName(host, name));
  const name = await askName(ctx, suggested);
  if (!name || name.trim() === "") return;
  try {
    const saved = saveFile(cwd, name, text, deps);
    notify(
      ctx,
      `Saved ${saved.path}${saved.renamed ? " (the name was taken, so a number was added)" : ""} · ${lineCount(text)} lines`,
    );
  } catch (error) {
    notify(ctx, `Could not save the export: ${(error as Error).message}`, "error");
  }
}
