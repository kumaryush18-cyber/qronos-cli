// "Waiting for 1 dynamic workflow to finish", drawn as its own row above the
// editor, while a background workflow is still running.
//
// Why it is separate from the working line: the working line belongs to the
// current turn and stops when the answer arrives. A workflow outlives the turn.
// Without this row the CLI looks idle while five agents are working and the
// token bill is going up, and the only thing you can do is remember that a run
// exists.
//
// The shape is Claude Code's: a `※`, the count in words, and a full stop. What
// we add is motion: the mark breathes and a pale-orange band flows through the
// words every 3 s, so a line that lives for ten minutes does not look frozen.
import type { ExtensionAPI, InlineExtension, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { BRAND_ORANGE, glowChar, orangeAnsi, RESET, shimmerPhase, shimmerText } from "./shimmer";

export const WAITING_WIDGET_ID = "qronos-workflow-waiting";

/** The mark Claude Code puts in front of this line. */
export const WAITING_MARK = "※";

/** How often the mark agrees to move. Claude Code's spinner speed. */
export const WAITING_FRAME_MS = 150;

/** The mark's own small cycle: bright, less bright, bright. */
const MARK_STEPS = [1, 0.72, 0.45, 0.72] as const;

/** The words of the line, with the count in plain English. */
export function waitingText(count: number): string {
  const safe = Math.max(0, Math.floor(count));
  if (safe === 1) return "Waiting for 1 dynamic workflow to finish";
  return `Waiting for ${safe} dynamic workflows to finish`;
}

export interface WaitingLineInput {
  count: number;
  /** Index into the mark's pulse. */
  frame: number;
  /** 0 -> 1 for one shimmer sweep; omit for a plain orange line. */
  shimmerPhase?: number;
}

/**
 * The whole line, e.g.
 *   ※ Waiting for 1 dynamic workflow to finish
 *
 * The mark is brand orange and its brightness cycles; the words carry the same
 * pale-orange band as the header and the working line, so one moving light
 * means "this is happening now" everywhere in the CLI.
 */
export function buildWaitingLine(input: WaitingLineInput): string {
  if (input.count <= 0) return "";
  const text = waitingText(input.count);
  const words =
    input.shimmerPhase === undefined ? `${orangeAnsi()}${text}${RESET}` : shimmerText(text, input.shimmerPhase);
  return `${markFor(input.frame)} ${words}`;
}

/**
 * The mark, breathing with the frame.
 *
 * It uses the same brand orange and the same pale-orange glow as everything
 * else, so the breathing reads as "this is alive" and not as a second colour
 * scheme invented for one line.
 */
function markFor(frame: number): string {
  const step = MARK_STEPS[((frame % MARK_STEPS.length) + MARK_STEPS.length) % MARK_STEPS.length]!;
  return glowChar(WAITING_MARK, BRAND_ORANGE, step * 0.55);
}

// --- one shared count, so a widget can be told without knowing the manager ---

let current = 0;
const listeners = new Set<(count: number) => void>();

/** How many background workflows are still running. */
export function waitingWorkflows(): number {
  return current;
}

/**
 * Say how many runs are live. Returns the count that is now in force.
 *
 * A plain number, not the manager: the waiting row must not be able to start,
 * stop or read a run. It only knows how many there are.
 */
export function setWaitingWorkflows(count: number): number {
  const next = Math.max(0, Math.floor(count));
  if (next === current) return current;
  current = next;
  for (const listener of [...listeners]) {
    try {
      listener(current);
    } catch {
      // A display hook must never break the thing it is reporting on.
    }
  }
  return current;
}

/** Listen for a change. Returns the unsubscribe function. */
export function subscribeWaiting(listener: (count: number) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test hook: forget the shared count and every listener. */
export function resetWaitingWorkflows(): void {
  current = 0;
  listeners.clear();
}

export interface CreateWaitingOptions {
  now?: () => number;
  frameMs?: number;
  /** Injected so a test can drive the line without a clock. */
  count?: () => number;
}

/**
 * Draws the waiting row above the editor, below the working line.
 *
 * The ticker only runs while something is waiting: a terminal that redraws
 * every 150 ms for no reason costs battery and makes a quiet CLI feel busy.
 */
export function createWorkflowWaitingExtension(opts: CreateWaitingOptions = {}): InlineExtension {
  const now = opts.now ?? Date.now;
  const frameMs = opts.frameMs ?? WAITING_FRAME_MS;
  const count = opts.count ?? waitingWorkflows;

  return {
    name: "qronos-workflow-waiting",
    factory(api: ExtensionAPI) {
      let tui: TUI | undefined;
      let timer: ReturnType<typeof setInterval> | null = null;
      let registered = false;
      let frame = 0;
      let cached: string[] = [];
      let cachedKey = "";

      const line = (): string => {
        if (count() <= 0) return "";
        return buildWaitingLine({ count: count(), frame, shimmerPhase: shimmerPhase(now()) });
      };

      const component: Component = {
        render: (width: number) => {
          const text = line();
          const key = `${text}:${width}`;
          if (key === cachedKey) return cached;
          cachedKey = key;
          cached = text ? [truncate(text, width)] : [];
          return cached;
        },
        invalidate: () => {
          cachedKey = "";
        },
      };

      const repaint = (): void => {
        try {
          tui?.requestRender();
        } catch {
          // Terminal gone: nothing to repaint.
        }
      };

      const stopTicker = (): void => {
        if (!timer) return;
        clearInterval(timer);
        timer = null;
      };

      const syncTicker = (): void => {
        if (count() > 0) {
          if (!timer) {
            timer = setInterval(() => {
              if (count() <= 0) {
                // One last frame, then nothing: the row must disappear when the
                // last run ends, and the timer must not keep the CLI awake.
                stopTicker();
              }
              frame += 1;
              repaint();
            }, frameMs);
          }
        } else {
          stopTicker();
        }
        repaint();
      };

      const registerWidget = (ctx: Parameters<Parameters<ExtensionAPI["on"]>[1]>[1]): void => {
        if (registered) return;
        registered = true;
        try {
          ctx.ui.setWidget(
            WAITING_WIDGET_ID,
            (widgetTui: TUI, _theme: Theme) => {
              tui = widgetTui;
              return component;
            },
            { placement: "aboveEditor" },
          );
        } catch {
          registered = false;
        }
      };

      api.on("session_start", (_event, ctx) => {
        // Registered after the working line, so this row sits below it and both
        // are above the ad box.
        registerWidget(ctx);
        syncTicker();
      });

      const unsubscribe = subscribeWaiting(() => syncTicker());
      api.on("session_shutdown", () => {
        unsubscribe();
        stopTicker();
      });
    },
  };
}

/** Cut a coloured line to the width, keeping the escape sequences whole. */
export function truncate(text: string, width: number): string {
  const visible = text.replace(/\x1b\[[0-9;]*m/g, "");
  if (visible.length <= width) return text;
  const plain = visible.slice(0, Math.max(0, width - 1)) + "…";
  return `${plain}${RESET}`;
}
