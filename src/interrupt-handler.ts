// Prompt history for the terminal.
//
// Design decision, corrected after review: **Escape is interrupt only.**
//
// pi binds Escape to app.interrupt ("Cancel or abort") and Claude Code uses it
// the same way — one press aborts the current generation. An earlier version
// here wrapped editor.onEscape so a second rapid press also restored the last
// prompt. That made one key mean two things: press twice to abort a long turn
// and you would silently get your old prompt back in the box, and mid-edit an
// Esc could either abandon the edit or restore an older one depending on timing.
// Both are surprising, so that wrap is gone: nothing in this module touches
// Escape.
//
// Recall now lives on its own explicit gesture — the /recall command — so the
// two actions never compete for one keystroke.
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";

/** How many submitted prompts are remembered. */
export const HISTORY_LIMIT = 50;

const history: string[] = [];

/** Text of the editor surface we need; injected so tests avoid a real TUI. */
export interface EditorLike {
  getText?: () => string;
  setText?: (text: string) => void;
}

/** Record a submitted prompt. Consecutive duplicates collapse. */
export function recordPrompt(prompt: string): void {
  const trimmed = prompt.trim();
  if (trimmed === "") return;
  if (history[history.length - 1] === trimmed) return;
  history.push(trimmed);
  while (history.length > HISTORY_LIMIT) history.shift();
}

/** Most recent prompt, or undefined when nothing has been submitted. */
export function lastPrompt(): string | undefined {
  return history[history.length - 1];
}

/**
 * `index` counts back from the most recent: 0 is the last prompt, 1 the one
 * before it. Out-of-range returns undefined rather than wrapping, so a /recall 9
 * with two prompts does nothing instead of silently restoring something old.
 */
export function promptAt(index: number): string | undefined {
  if (!Number.isInteger(index) || index < 0) return undefined;
  return history[history.length - 1 - index];
}

export function historySize(): number {
  return history.length;
}

/** Test seam. */
export function resetHistory(): void {
  history.length = 0;
}

/**
 * Put a remembered prompt back in the editor. Returns what was restored.
 * Refuses to clobber text the user is actively typing: overwriting a half-written
 * message would be exactly the kind of surprise the Escape wrap was removed for.
 */
export function recallInto(
  editor: EditorLike | undefined,
  index: number,
  opts: { force?: boolean } = {},
): { restored?: string; reason?: "empty-history" | "out-of-range" | "editor-busy" | "no-editor" } {
  const prompt = promptAt(index);
  if (history.length === 0) return { reason: "empty-history" };
  if (prompt === undefined) return { reason: "out-of-range" };
  if (!editor?.setText) return { reason: "no-editor" };
  const current = editor.getText?.() ?? "";
  if (current.trim() !== "" && !opts.force) return { reason: "editor-busy" };
  editor.setText(prompt);
  return { restored: prompt };
}

export function createPromptHistoryExtension(): InlineExtension {
  return {
    name: "qronos-prompt-history",
    factory(pi: ExtensionAPI) {
      // "input" fires once per submission (before the agent runs), which is
      // exactly the prompt worth remembering.
      pi.on("input", (event) => {
        if (event.text) recordPrompt(event.text);
        return { action: "continue" };
      });
    },
  };
}
