// Time, in the two places a resumable workflow needs it.
//
// 1. The wall clock that stops a runaway run. It must PAUSE when the user pauses
//    the run: a run that spends its ten minutes waiting for a person is a bug,
//    not protection. So the limit is a countdown that can be stopped and started
//    again, keeping what was left.
// 2. The clock the SCRIPT sees. A resumed run replays the script from the top, so
//    anything the script reads must give the same answer the second time. A frozen
//    clock does that.
//
// Claude Code refuses `Date.now()` and `Math.random()` inside a workflow script so
// a replay cannot diverge. We keep both working but stable: `Date.now()` returns
// the run's start time, `Math.random()` is a seeded generator. A replay still
// repeats itself exactly, and a script that stamps a report or shuffles a list
// keeps working. docs/workflows.md states this difference plainly.
import type { WorkflowTimeoutError } from "./workflow-types";

export interface ResumableWallClock {
  /** Start (or restart) counting from what is left. */
  start(onExpire: () => void): void;
  /** Stop counting; the time left is kept for `start`. */
  pause(): void;
  stop(): void;
  readonly remainingMs: number;
  readonly running: boolean;
}

/**
 * A countdown that survives a pause.
 *
 * `now` is injected so a test can move time by hand instead of sleeping.
 */
export function createResumableWallClock(
  totalMs: number,
  options: { now?: () => number; schedule?: (fn: () => void, ms: number) => unknown; cancel?: (handle: unknown) => void } = {},
): ResumableWallClock {
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  const cancel = options.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  let remaining = Math.max(1, Math.floor(totalMs));
  let handle: unknown;
  let startedAt = 0;
  let running = false;

  const clear = () => {
    if (handle !== undefined) {
      cancel(handle);
      handle = undefined;
    }
  };

  return {
    start(onExpire: () => void): void {
      if (running) return;
      running = true;
      startedAt = now();
      handle = schedule(() => {
        running = false;
        handle = undefined;
        remaining = 0;
        onExpire();
      }, remaining);
      // A pending timer must not keep the process alive on its own.
      const asTimer = handle as { unref?: () => void } | undefined;
      asTimer?.unref?.();
    },
    pause(): void {
      if (!running) return;
      running = false;
      clear();
      remaining = Math.max(0, remaining - (now() - startedAt));
    },
    stop(): void {
      running = false;
      clear();
    },
    get remainingMs(): number {
      return running ? Math.max(0, remaining - (now() - startedAt)) : remaining;
    },
    get running(): boolean {
      return running;
    },
  };
}

export interface FrozenClock {
  /** Always the run's start time, so a replay makes the same decisions. */
  now(): number;
  /** A `Date` class whose `new Date()` and `Date.now()` use that time. */
  dateClass: DateConstructor;
}

/**
 * A clock stuck at one moment.
 *
 * The returned `Date` still accepts explicit arguments (`new Date(0)`), so only
 * the "what time is it now" answers are frozen. That is the part a replay needs.
 */
export function createFrozenClock(baseMs: number): FrozenClock {
  const fixed = Math.floor(baseMs);
  const Frozen = function DateShim(this: unknown, ...args: unknown[]) {
    if (!new.target) return new globalThis.Date(fixed).toString();
    if (args.length === 0) return new globalThis.Date(fixed);
    return new (globalThis.Date as unknown as new (...inner: unknown[]) => Date)(...args);
  } as unknown as DateConstructor;
  Frozen.now = () => fixed;
  Frozen.parse = globalThis.Date.parse;
  Frozen.UTC = globalThis.Date.UTC;
  Object.defineProperty(Frozen, "prototype", { value: globalThis.Date.prototype });
  return { now: () => fixed, dateClass: Frozen };
}

/** The error a wall clock throws when it runs out. Kept here so callers agree. */
export function wallClockMessage(ms: number): string {
  // Below two minutes, "1 minute" would be a lie about a 30 second cap.
  const minutes = Math.round(ms / 60_000);
  return ms >= 120_000
    ? `the workflow hit its ${minutes} minute wall clock (QRONOS_WORKFLOW_WALL_CLOCK_MS)`
    : `the workflow hit its ${Math.round(ms / 1000)} second wall clock (QRONOS_WORKFLOW_WALL_CLOCK_MS)`;
}

export type { WorkflowTimeoutError };
