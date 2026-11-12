// Prompt recall for the terminal, Claude-Code style.
//
// What pi already does (verified in its InteractiveMode.setupKeyHandlers):
//   Escape, edited text empty, twice within 500ms -> the *doubleEscapeAction*
//   setting decides between the tree selector and the user-message selector.
//   So pi owns the Esc window; an extension must not register Escape itself.
//
// The first implementation here registered  pi.registerShortcut("escape")  and
// its recall callback only called ctx.ui.notify(). Two bugs: Escape is pi's
// app.interrupt binding, so the registration either shadowed interrupt or did
// nothing; and the prompt was never put back into the editor.
//
// This version does not claim the key. It wraps `editor.onEscape` the same way
// footer-align wraps `footer.render`, and on the second rapid Esc it puts the
// last submitted prompt back into the editor via setText. pi's own handler still
// runs, so tree/selector behaviour is preserved.
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";

export const DOUBLE_ESC_THRESHOLD_MS = 500;

export interface InterruptState {
  lastUserPrompt?: string;
  lastEscTimestamp: number;
}

const state: InterruptState = {
  lastUserPrompt: undefined,
  lastEscTimestamp: 0,
};

export function setLastUserPrompt(prompt: string): void {
  const trimmed = prompt.trim();
  if (trimmed.length > 0) state.lastUserPrompt = trimmed;
}

export function getLastUserPrompt(): string | undefined {
  return state.lastUserPrompt;
}

/** Test seam: forget everything between tests. */
export function resetInterruptState(): void {
  state.lastUserPrompt = undefined;
  state.lastEscTimestamp = 0;
}

/**
 * Record an Esc press. Returns the prompt to restore when this press completes
 * a double-tap, else undefined.
 *
 * `lastEscTimestamp > 0` and `delta > 0` together reject the degenerate case
 * where the same press is seen twice at the same instant.
 */
export function handleEscapeKey(now: number = Date.now()): string | undefined {
  const delta = now - state.lastEscTimestamp;
  const isDouble = state.lastEscTimestamp > 0 && delta > 0 && delta <= DOUBLE_ESC_THRESHOLD_MS;
  state.lastEscTimestamp = now;
  if (isDouble && state.lastUserPrompt) return state.lastUserPrompt;
  return undefined;
}

/** Injectable editor surface, so the wrap is testable without a TUI. */
export interface EditorLike {
  onEscape?: () => void;
  getText?: () => string;
  setText?: (text: string) => void;
}

export interface RecallHooks {
  now?: () => number;
  /** Called when a prompt is restored, for a one-line confirmation. */
  onRecall?: (prompt: string) => void;
}

/**
 * Install the double-Esc recall on a live editor. Idempotent-safe: wrapping
 * twice would double the timing state, so callers install once per mode.
 */
export function installPromptRecall(editor: EditorLike, hooks: RecallHooks = {}): void {
  const now = hooks.now ?? (() => Date.now());
  const previous = editor.onEscape;

  editor.onEscape = () => {
    // Let pi keep its own Escape semantics (interrupt, tree, selector).
    previous?.();

    // Only a *second* Esc on an empty editor is a recall gesture. If the user is
    // mid-edit, Escape means "abandon this edit", not "restore the last prompt".
    const current = editor.getText?.() ?? "";
    if (current.trim() !== "") return;

    const recalled = handleEscapeKey(now());
    if (recalled) {
      editor.setText?.(recalled);
      // A restored prompt is a fresh edit, so the next Esc should not chain into
      // another recall.
      state.lastEscTimestamp = 0;
      hooks.onRecall?.(recalled);
    }
  };
}

export interface CreateInterruptOptions {
  now?: () => number;
}

export function createInterruptExtension(opts: CreateInterruptOptions = {}): InlineExtension {
  return {
    name: "qronos-interrupt",
    factory(pi: ExtensionAPI) {
      // "input" fires once per submission (before the agent runs), which is
      // exactly the prompt worth recalling.
      pi.on("input", (event) => {
        if (event.text) setLastUserPrompt(event.text);
        return { action: "continue" };
      });

      // A new turn means the previous prompt is no longer the "last" one to
      // return to; clear the window so a stale timestamp cannot pair with a
      // later Escape.
      pi.on("turn_start", () => {
        state.lastEscTimestamp = 0;
      });
    },
  };
}
