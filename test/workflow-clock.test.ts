import { describe, expect, test } from "bun:test";
import { createFrozenClock, createResumableWallClock, wallClockMessage } from "../src/workflow-clock";

/** A wall clock driven by hand: no sleeping, no flakiness. */
function harness(totalMs: number) {
  let time = 0;
  const timers: Array<{ at: number; fn: () => void; id: number }> = [];
  let nextId = 1;
  const clock = createResumableWallClock(totalMs, {
    now: () => time,
    schedule: (fn, ms) => {
      const id = nextId++;
      timers.push({ at: time + ms, fn, id });
      return id;
    },
    cancel: (handle) => {
      const index = timers.findIndex((timer) => timer.id === handle);
      if (index >= 0) timers.splice(index, 1);
    },
  });
  const advance = (ms: number) => {
    time += ms;
    for (const timer of [...timers].sort((a, b) => a.at - b.at)) {
      if (timer.at > time) continue;
      const index = timers.indexOf(timer);
      if (index >= 0) timers.splice(index, 1);
      timer.fn();
    }
  };
  return { clock, advance, timers, now: () => time };
}

describe("createResumableWallClock", () => {
  test("fires when the time runs out", () => {
    const { clock, advance } = harness(1_000);
    let fired = 0;
    clock.start(() => {
      fired += 1;
    });
    advance(999);
    expect(fired).toBe(0);
    advance(2);
    expect(fired).toBe(1);
    expect(clock.running).toBe(false);
  });

  test("pause keeps what is left", () => {
    const { clock, advance } = harness(1_000);
    let fired = 0;
    clock.start(() => {
      fired += 1;
    });
    advance(400);
    clock.pause();
    expect(clock.remainingMs).toBe(600);
    // Time passes while paused; it must not count.
    advance(10_000);
    expect(fired).toBe(0);
    expect(clock.remainingMs).toBe(600);
  });

  test("start after a pause uses the time that was left", () => {
    const { clock, advance } = harness(1_000);
    let fired = 0;
    clock.start(() => {
      fired += 1;
    });
    advance(400);
    clock.pause();
    advance(5_000);
    clock.start(() => {
      fired += 1;
    });
    advance(599);
    expect(fired).toBe(0);
    advance(2);
    expect(fired).toBe(1);
  });

  test("start twice does not double the timer", () => {
    const { clock, advance, timers } = harness(1_000);
    let fired = 0;
    clock.start(() => {
      fired += 1;
    });
    clock.start(() => {
      fired += 1;
    });
    expect(timers).toHaveLength(1);
    advance(1_001);
    expect(fired).toBe(1);
  });

  test("stop cancels without firing", () => {
    const { clock, advance, timers } = harness(1_000);
    let fired = 0;
    clock.start(() => {
      fired += 1;
    });
    clock.stop();
    expect(timers).toHaveLength(0);
    advance(2_000);
    expect(fired).toBe(0);
    expect(clock.running).toBe(false);
  });

  test("a zero or negative total still leaves a real timer", () => {
    const { clock, advance } = harness(0);
    let fired = 0;
    clock.start(() => {
      fired += 1;
    });
    advance(2);
    expect(fired).toBe(1);
  });

  test("pause on a clock that never started is harmless", () => {
    const { clock } = harness(1_000);
    clock.pause();
    expect(clock.remainingMs).toBe(1_000);
    expect(clock.running).toBe(false);
  });
});

describe("createFrozenClock", () => {
  test("Date.now() answers with the frozen moment", () => {
    const { dateClass } = createFrozenClock(1_700_000_000_000);
    expect(dateClass.now()).toBe(1_700_000_000_000);
  });

  test("new Date() answers with the frozen moment", () => {
    const { dateClass } = createFrozenClock(0);
    expect(new dateClass().getTime()).toBe(0);
  });

  test("an explicit argument still works, so a script can format a known time", () => {
    const { dateClass } = createFrozenClock(1_700_000_000_000);
    expect(new dateClass(0).getTime()).toBe(0);
    expect(new dateClass("2020-01-01T00:00:00.000Z").getUTCFullYear()).toBe(2020);
  });

  test("calling it as a function still gives a date string", () => {
    const { dateClass } = createFrozenClock(0);
    const asString = (dateClass as unknown as () => string)();
    expect(typeof asString).toBe("string");
    expect(asString.length).toBeGreaterThan(10);
  });

  test("parse and UTC are still the real ones", () => {
    const { dateClass } = createFrozenClock(0);
    expect(dateClass.parse("1970-01-01T00:00:00.000Z")).toBe(0);
    expect(dateClass.UTC(1970, 0, 1)).toBe(0);
  });

  test("now() is the same answer twice", () => {
    const clock = createFrozenClock(123);
    expect(clock.now()).toBe(clock.now());
  });
});

describe("wallClockMessage", () => {
  test("names the cap in minutes when it is long enough", () => {
    expect(wallClockMessage(600_000)).toContain("10 minute");
  });

  test("names the cap in seconds when it is short", () => {
    expect(wallClockMessage(30_000)).toContain("30 second");
  });

  test("always names the env var, so the fix is findable", () => {
    expect(wallClockMessage(600_000)).toContain("QRONOS_WORKFLOW_WALL_CLOCK_MS");
  });
});
