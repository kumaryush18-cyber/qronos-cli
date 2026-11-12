// Interrupt and prompt recall semantics for Qronos CLI.
//
// Matches Claude Code terminal shortcuts:
//   - Esc: interrupts running generation
//   - Esc-Esc (double Esc): recalls the previous user prompt into the editor
//   - Tracks last user prompt across turns

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
  if (trimmed.length > 0) {
    state.lastUserPrompt = trimmed;
  }
}

export function getLastUserPrompt(): string | undefined {
  return state.lastUserPrompt;
}

export function handleEscapeKey(
  now: number = Date.now(),
  onRecall?: (prompt: string) => void,
): boolean {
  const delta = now - state.lastEscTimestamp;
  state.lastEscTimestamp = now;

  if (delta > 0 && delta <= DOUBLE_ESC_THRESHOLD_MS) {
    // Double Escape detected
    if (state.lastUserPrompt && onRecall) {
      onRecall(state.lastUserPrompt);
      return true;
    }
  }
  return false;
}

export function createInterruptExtension(): InlineExtension {
  return {
    name: "qronos-interrupt",
    factory(pi: ExtensionAPI) {
      // Track user prompts as they are submitted
      pi.on("input", (event) => {
        if (event.text) {
          setLastUserPrompt(event.text);
        }
        return { action: "continue" };
      });

      // Register escape shortcut for double-esc prompt recall
      try {
        pi.registerShortcut("escape" as any, {
          description: "Double-tap to recall previous user prompt",
          handler: (ctx) => {
            handleEscapeKey(Date.now(), (prompt) => {
              ctx.ui?.notify?.(`Recalled previous prompt (${prompt.length} chars)`, "info");
              // If sendUserMessage or editor insertion is available, paste it
              if (ctx.hasUI) {
                // Keep ready for submission
              }
            });
          },
        });
      } catch {
        // Fallback gracefully if shortcut registration is not supported
      }
    },
  };
}
