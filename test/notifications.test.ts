// Tests for desktop notifications and the frame-rate cap. Both are invisible
// when they work, so the tests pin the three things that can actually break a
// terminal: the escape sequence shape, the sanitising of user text, and staying
// silent on a terminal we do not recognise.
import { describe, expect, test } from "bun:test";
import {
  createNotifier,
  detectNotifyProtocol,
  notificationSequence,
  notificationsEnabled,
  resolveNotifyProtocol,
  sanitizeNotificationText,
  turnEndMessage,
} from "../src/notifications";
import { createNotifyExtension } from "../src/notify-extension";
import {
  applyFrameInterval,
  ENGINE_FRAME_INTERVAL_MS,
  frameIntervalMs,
  installFrameRateCap,
  resolveMaxFps,
} from "../src/frame-rate";

const OSC9_END = "\x1b\\";

describe("terminal detection", () => {
  test("known terminals are recognised", () => {
    expect(detectNotifyProtocol({ TERM_PROGRAM: "iTerm.app" })).toBe("osc9");
    expect(detectNotifyProtocol({ TERM_PROGRAM: "WezTerm" })).toBe("osc9");
    expect(detectNotifyProtocol({ WT_SESSION: "abc" })).toBe("osc9");
    expect(detectNotifyProtocol({ TERM_PROGRAM: "Konsole" })).toBe("osc777");
  });

  test("an unknown terminal stays silent", () => {
    expect(detectNotifyProtocol({ TERM_PROGRAM: "Apple_Terminal" })).toBe("none");
    expect(detectNotifyProtocol({})).toBe("none");
  });

  test("QRONOS_NOTIFY overrides detection in both directions", () => {
    expect(resolveNotifyProtocol({ TERM_PROGRAM: "iTerm.app", QRONOS_NOTIFY: "0" })).toBe("none");
    expect(resolveNotifyProtocol({ QRONOS_NOTIFY: "1" })).toBe("osc9");
    expect(notificationsEnabled({ QRONOS_NOTIFY: "0" })).toBe(false);
    expect(notificationsEnabled({ TERM_PROGRAM: "ghostty" })).toBe(true);
    expect(notificationsEnabled({})).toBe(false);
  });
});

describe("notificationSequence", () => {
  test("OSC 9 carries title and body, terminated by ST", () => {
    const sequence = notificationSequence("osc9", "Qronos CLI", "Done after 2 min");
    expect(sequence).toBe(`\x1b]9;Qronos CLI: Done after 2 min${OSC9_END}`);
    expect(sequence.endsWith(OSC9_END)).toBe(true);
  });

  test("OSC 777 uses the notify;title;body form", () => {
    expect(notificationSequence("osc777", "Qronos", "Done")).toBe(`\x1b]777;notify;Qronos;Done${OSC9_END}`);
  });

  test("none produces nothing at all", () => {
    expect(notificationSequence("none", "t", "b")).toBe("");
  });

  test("control characters in the text cannot break the sequence", () => {
    const sequence = notificationSequence("osc9", "Qronos\nCLI", "Done\x07\x1b[31m now");
    expect(sequence.includes("\n")).toBe(false);
    expect(sequence.includes("\x07")).toBe(false);
    // The only ESC left is the sequence opener and the ST terminator.
    expect(sequence.match(/\x1b/g)?.length).toBe(2);
  });

  test("long text is clipped with an ellipsis", () => {
    const text = sanitizeNotificationText("x".repeat(500));
    expect(text.length).toBe(200);
    expect(text.endsWith("…")).toBe(true);
  });
});

describe("createNotifier", () => {
  test("writes one sequence to the terminal", () => {
    const written: string[] = [];
    const notify = createNotifier({ env: { TERM_PROGRAM: "iTerm.app" }, write: (chunk) => written.push(chunk) });
    notify("Qronos CLI", "Done");
    expect(written.length).toBe(1);
    expect(written[0]).toContain("Done");
  });

  test("writes nothing on an unsupported terminal", () => {
    const written: string[] = [];
    const notify = createNotifier({ env: {}, write: (chunk) => written.push(chunk) });
    notify("Qronos CLI", "Done");
    expect(written).toEqual([]);
  });

  test("a broken writer never throws into the session", () => {
    const notify = createNotifier({
      env: { TERM_PROGRAM: "iTerm.app" },
      write: () => {
        throw new Error("EPIPE");
      },
    });
    expect(() => notify("t", "b")).not.toThrow();
  });
});

describe("turnEndMessage", () => {
  test("says what happened in a few words", () => {
    expect(turnEndMessage({ seconds: 10 })).toBe("Done");
    expect(turnEndMessage({ seconds: 150 })).toBe("Done after 3 min");
    expect(turnEndMessage({ aborted: true, seconds: 10 })).toBe("Stopped — back to you");
    expect(turnEndMessage({ hadError: true, seconds: 10 })).toContain("went wrong");
  });
});

describe("createNotifyExtension", () => {
  test("notifies on a long turn only, and names the elapsed time", async () => {
    const handlers = new Map<string, (...args: any[]) => any>();
    const sent: string[] = [];
    let clock = 0;
    const extension = createNotifyExtension({
      notifier: (_title, body) => sent.push(body),
      now: () => clock,
    })!;
    extension({ on: (event: string, handler: any) => handlers.set(event, handler) } as any);

    // Short turn: silent.
    clock = 0;
    await handlers.get("turn_start")!();
    clock = 2000;
    await handlers.get("turn_end")!({ aborted: false }, {});
    expect(sent).toEqual([]);

    // Long turn: one notification.
    clock = 0;
    await handlers.get("turn_start")!();
    clock = 125_000;
    await handlers.get("turn_end")!({ aborted: false }, {});
    expect(sent).toEqual(["Done after 2 min"]);
  });
});

describe("frame rate", () => {
  test("unset or off keeps the engine default", () => {
    expect(resolveMaxFps({})).toBeUndefined();
    expect(resolveMaxFps({ QRONOS_FPS: "0" })).toBeUndefined();
    expect(resolveMaxFps({ QRONOS_FPS: "off" })).toBeUndefined();
    expect(resolveMaxFps({ QRONOS_FPS: "fast" })).toBeUndefined();
  });

  test("values are clamped into 5..60 fps", () => {
    expect(resolveMaxFps({ QRONOS_FPS: "30" })).toBe(30);
    expect(resolveMaxFps({ QRONOS_FPS: "1" })).toBe(5);
    expect(resolveMaxFps({ QRONOS_FPS: "240" })).toBe(60);
  });

  test("interval never goes below the engine's 16 ms", () => {
    expect(frameIntervalMs(60)).toBe(ENGINE_FRAME_INTERVAL_MS);
    expect(frameIntervalMs(30)).toBe(33);
    expect(frameIntervalMs(5)).toBe(200);
  });

  test("applying the cap writes the static on the base class", () => {
    const target = { MIN_RENDER_INTERVAL_MS: ENGINE_FRAME_INTERVAL_MS };
    expect(applyFrameInterval(target, 30)).toBe(33);
    expect(target.MIN_RENDER_INTERVAL_MS).toBe(33);
    // Asking for the default means "do not touch", and returns undefined.
    expect(applyFrameInterval(target, 60)).toBeUndefined();
    expect(applyFrameInterval(undefined, 30)).toBeUndefined();
  });

  test("installFrameRateCap is a no-op without the env var", () => {
    expect(installFrameRateCap({})).toBeUndefined();
  });
});