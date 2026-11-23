// /export, the clipboard half: which road we take, and what happens when a road
// is closed. No real clipboard is touched here.
import { describe, expect, test } from "bun:test";
import { clipboardCommands, copyToClipboard, OSC52_MAX_ENCODED } from "../src/export-clipboard";

describe("clipboardCommands", () => {
  test("macOS uses pbcopy", () => {
    expect(clipboardCommands("darwin", {})).toEqual([["pbcopy", []]]);
  });

  test("Windows uses clip", () => {
    expect(clipboardCommands("win32", {})).toEqual([["clip", []]]);
  });

  test("Wayland comes before X11", () => {
    const commands = clipboardCommands("linux", { WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" });
    expect(commands[0]?.[0]).toBe("wl-copy");
    expect(commands.map(([name]) => name)).toContain("xclip");
  });

  test("Termux uses its own program first", () => {
    const commands = clipboardCommands("linux", { TERMUX_VERSION: "0.118", DISPLAY: ":0" });
    expect(commands[0]?.[0]).toBe("termux-clipboard-set");
  });

  test("a plain headless Linux box has no program at all", () => {
    expect(clipboardCommands("linux", {})).toEqual([]);
  });
});

describe("copyToClipboard", () => {
  test("a local session copies with the platform program", async () => {
    const result = await copyToClipboard("hello", {
      platform: "darwin",
      env: {},
      runProgram: async () => true,
      writeOsc52: () => false,
    });
    expect(result).toEqual({ ok: true, how: "pbcopy" });
  });

  test("the words really reach the program", async () => {
    let seen = "";
    await copyToClipboard("exact text", {
      platform: "linux",
      env: { DISPLAY: ":0" },
      runProgram: async (_command, _args, input) => {
        seen = input;
        return true;
      },
      writeOsc52: () => false,
    });
    expect(seen).toBe("exact text");
  });

  test("a remote session prefers OSC 52, because the program is on the wrong machine", async () => {
    let ran = false;
    const result = await copyToClipboard("hi", {
      platform: "linux",
      env: { SSH_CONNECTION: "1 2 3 4" },
      runProgram: async () => {
        ran = true;
        return true;
      },
      writeOsc52: () => true,
    });
    expect(result).toEqual({ ok: true, how: "osc52" });
    expect(ran).toBe(false);
  });

  test("when every program is missing, OSC 52 is the last try", async () => {
    const result = await copyToClipboard("hi", {
      platform: "linux",
      env: {},
      runProgram: async () => false,
      writeOsc52: () => true,
    });
    expect(result).toEqual({ ok: true, how: "osc52" });
  });

  test("nothing works, and that is an answer, not a crash", async () => {
    const result = await copyToClipboard("hi", {
      platform: "linux",
      env: {},
      runProgram: async () => false,
      writeOsc52: () => false,
    });
    expect(result).toEqual({ ok: false, how: "none" });
  });

  test("a text too big for OSC 52 is refused by the writer, not sent half way", async () => {
    const huge = "x".repeat(OSC52_MAX_ENCODED);
    const result = await copyToClipboard(huge, {
      platform: "linux",
      env: { SSH_CONNECTION: "1 2 3 4" },
      runProgram: async () => false,
      // The real writer refuses when the base64 form is over the limit.
      writeOsc52: (text) => Buffer.from(text).toString("base64").length <= OSC52_MAX_ENCODED,
    });
    expect(result.ok).toBe(false);
  });
});
