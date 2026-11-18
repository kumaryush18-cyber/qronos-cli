import { describe, expect, test } from "bun:test";
import {
  buildFrames,
  createThinkingMeterExtension,
  formatTokenCount,
  FRAME_INTERVAL_MS,
  MIN_UPDATE_MS,
  SPINNER_FRAMES,
} from "../src/thinking-meter";

describe("formatTokenCount", () => {
  test("small counts stay exact", () => {
    expect(formatTokenCount(0)).toBe("0");
    expect(formatTokenCount(847)).toBe("847");
    expect(formatTokenCount(999)).toBe("999");
  });

  test("thousands use one decimal below 10k, whole numbers above", () => {
    expect(formatTokenCount(1000)).toBe("1.0k");
    expect(formatTokenCount(1234)).toBe("1.2k");
    expect(formatTokenCount(12_340)).toBe("12k");
    expect(formatTokenCount(199_999)).toBe("200k");
  });

  test("millions use one decimal", () => {
    expect(formatTokenCount(1_240_000)).toBe("1.2M");
    expect(formatTokenCount(1_000_000)).toBe("1.0M");
  });

  test("unknown or invalid input returns undefined, never a fake number", () => {
    expect(formatTokenCount(null)).toBeUndefined();
    expect(formatTokenCount(undefined)).toBeUndefined();
    expect(formatTokenCount(Number.NaN)).toBeUndefined();
    expect(formatTokenCount(-5)).toBeUndefined();
  });
});

describe("buildFrames", () => {
  test("unknown count falls back to the plain spinner", () => {
    expect(buildFrames(undefined)).toEqual([...SPINNER_FRAMES]);
    expect(buildFrames(null)).toEqual([...SPINNER_FRAMES]);
  });

  test("each frame carries the arrow and the count", () => {
    const frames = buildFrames(12_340);
    expect(frames).toHaveLength(SPINNER_FRAMES.length);
    expect(frames[0]).toBe("⠋ ↓ 12k");
    expect(frames.every((f) => f.includes("↓ 12k"))).toBe(true);
  });

  test("frames stay one line wide (no wrapping in narrow terminals)", () => {
    const frames = buildFrames(1_240_000);
    expect(frames[0]).toBe("⠋ ↓ 1.2M");
  });
});

describe("qronos-thinking-meter extension", () => {
  function harness(tokens: number | undefined) {
    const calls: { frames: string[]; intervalMs: number }[] = [];
    const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
    const api = {
      on(type: string, handler: (event: unknown, ctx: unknown) => void) {
        handlers.set(type, handler);
        return () => {};
      },
    };
    const ctx = {
      getContextUsage: () => (tokens === undefined ? undefined : { tokens }),
      ui: {
        setWorkingIndicator: (options: { frames: string[]; intervalMs: number }) => calls.push(options),
      },
    };
    const ext = createThinkingMeterExtension({ now: () => 0 }) as { factory: (pi: never) => void };
    ext.factory(api as never);
    return { handlers, ctx, calls };
  }

  test("session_start sets frames with the real token count", () => {
    const { handlers, ctx, calls } = harness(12_340);
    handlers.get("session_start")!({}, ctx);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.frames[0]).toBe("⠋ ↓ 12k");
    expect(calls[0]!.intervalMs).toBe(FRAME_INTERVAL_MS);
  });

  test("unknown context size keeps the plain spinner", () => {
    const { handlers, ctx, calls } = harness(undefined);
    handlers.get("session_start")!({}, ctx);
    expect(calls[0]!.frames).toEqual([...SPINNER_FRAMES]);
  });

  test("message_update is throttled: same count and same instant do not repaint", () => {
    const { handlers, ctx, calls } = harness(5000);
    handlers.get("session_start")!({}, ctx);
    handlers.get("message_update")!({}, ctx);
    handlers.get("message_update")!({}, ctx);
    expect(calls).toHaveLength(1);
  });

  test("registered events are exactly the three the meter needs", () => {
    const { handlers } = harness(10);
    expect([...handlers.keys()].sort()).toEqual(["message_update", "session_start", "turn_end"]);
  });

  test("throttle window is short enough to feel live", () => {
    expect(MIN_UPDATE_MS).toBeLessThanOrEqual(500);
  });
});
