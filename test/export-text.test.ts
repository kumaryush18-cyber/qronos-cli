// /export, the text half: the name, the lines, and the no-overwrite rule.
import { describe, expect, test } from "bun:test";
import {
  buildExportText,
  exportFileName,
  exportSlug,
  firstUserText,
  freeFileName,
  toolCallLine,
  EXPORT_MAX_CHARS,
} from "../src/export-text";

const NOW = new Date(2026, 10, 23, 10, 48, 46); // 23 Nov 2026, 10:48:46 local

function user(text: string) {
  return { type: "message", message: { role: "user", content: text } };
}

function assistant(content: unknown[]) {
  return { type: "message", message: { role: "assistant", content } };
}

describe("exportSlug", () => {
  test("keeps a short word as it is", () => {
    expect(exportSlug("hi")).toBe("hi");
  });

  test("turns a sentence into dashes", () => {
    expect(exportSlug("Fix the login bug!")).toBe("fix-the-login-bug");
  });

  test("never returns an empty slug", () => {
    expect(exportSlug("   ")).toBe("conversation");
    expect(exportSlug("!!!")).toBe("conversation");
  });

  test("cuts a long slug on a word boundary, not a dash", () => {
    const slug = exportSlug("a".repeat(50));
    expect(slug.length).toBe(30);
    expect(slug.endsWith("-")).toBe(false);
  });
});

describe("exportFileName", () => {
  test("puts the date first so a folder sorts by time", () => {
    expect(exportFileName(NOW, "hi")).toBe("2026-11-23-104846-hi.txt");
  });

  test("uses the slug of the first message", () => {
    expect(exportFileName(NOW, "Fix the login bug")).toBe("2026-11-23-104846-fix-the-login-bug.txt");
  });

  test("pads every number, so names sort correctly", () => {
    expect(exportFileName(new Date(2026, 0, 5, 3, 4, 5), "x")).toBe("2026-01-05-030405-x.txt");
  });
});

describe("firstUserText", () => {
  test("skips assistant turns and takes the first user words", () => {
    const entries = [assistant([{ type: "text", text: "hello" }]), user("the real question")];
    expect(firstUserText(entries)).toBe("the real question");
  });

  test("reads text blocks in a content array", () => {
    const entries = [{ type: "message", message: { role: "user", content: [{ type: "text", text: "block text" }] } }];
    expect(firstUserText(entries)).toBe("block text");
  });

  test("is empty when the user said nothing", () => {
    expect(firstUserText([])).toBe("");
  });
});

describe("toolCallLine", () => {
  test("draws a command the Claude way", () => {
    expect(toolCallLine("bash", { command: "ls -la" })).toBe("● Bash(ls -la)");
  });

  test("powershell is Bash to a reader too", () => {
    expect(toolCallLine("powershell", { command: "Get-ChildItem" })).toBe("● Bash(Get-ChildItem)");
  });

  test("shows a path for a file tool", () => {
    expect(toolCallLine("read", { file_path: "src/index.ts" })).toBe("● read(src/index.ts)");
  });

  test("shows no brackets when there is no argument", () => {
    expect(toolCallLine("find", {})).toBe("● find");
  });
});

describe("buildExportText", () => {
  test("writes a heading, the directory, and the turns", () => {
    const text = buildExportText({
      entries: [user("hi"), assistant([{ type: "text", text: "Hello! How can I help?" }])],
      cwd: "/projects/demo",
      model: "claude-haiku-5.5",
      now: NOW,
    });
    expect(text).toContain("Qronos CLI conversation · 2026-11-23 10:48");
    expect(text).toContain("Model: claude-haiku-5.5");
    expect(text).toContain("Working directory: /projects/demo");
    expect(text).toContain("❯ hi");
    expect(text).toContain("● Hello! How can I help?");
  });

  test("a tool call is followed by its first result lines", () => {
    const text = buildExportText({
      entries: [
        user("list the files"),
        assistant([{ type: "toolCall", name: "bash", arguments: { command: "ls" } }]),
        {
          type: "message",
          message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "a.ts\nb.ts" }] },
        },
      ],
      cwd: "/projects/demo",
      now: NOW,
    });
    expect(text).toContain("● Bash(ls)");
    expect(text).toContain("⎿  a.ts");
    expect(text).toContain("b.ts");
  });

  test("a failing result is labelled Error", () => {
    const text = buildExportText({
      entries: [
        user("run it"),
        {
          type: "message",
          message: { role: "toolResult", toolName: "bash", isError: true, content: "command not found" },
        },
      ],
      now: NOW,
      cwd: "/x",
    });
    expect(text).toContain("Error: command not found");
  });

  test("thinking blocks stay out of the file", () => {
    const text = buildExportText({
      entries: [user("hi"), assistant([{ type: "thinking", thinking: "secret plan" }, { type: "text", text: "done" }])],
      cwd: "/x",
      now: NOW,
    });
    expect(text).not.toContain("secret plan");
    expect(text).toContain("● done");
  });

  test("a secret is redacted before it reaches the disk", () => {
    const text = buildExportText({
      entries: [user("my key is sk-live-abcdefghijklmnop")],
      cwd: "/x",
      now: NOW,
    });
    expect(text).not.toContain("sk-live-abcdefghijklmnop");
    expect(text).toContain("[redacted]");
  });

  test("colours from a tool result are stripped", () => {
    const text = buildExportText({
      entries: [
        user("hi"),
        { type: "message", message: { role: "toolResult", content: "\u001b[31mred\u001b[0m text" } },
      ],
      cwd: "/x",
      now: NOW,
    });
    expect(text).toContain("red text");
    expect(text).not.toContain("\u001b[31m");
  });

  test("a compaction is one short line", () => {
    const text = buildExportText({ entries: [user("hi"), { type: "compaction" }], cwd: "/x", now: NOW });
    expect(text).toContain("✻ Context compacted");
  });

  test("no trailing blank lines, and one final newline", () => {
    const text = buildExportText({ entries: [user("hi")], cwd: "/x", now: NOW });
    expect(text.endsWith("\n")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(false);
  });

  test("a huge transcript is cut, and says so", () => {
    const big = "x".repeat(EXPORT_MAX_CHARS + 100);
    const text = buildExportText({ entries: [user(big)], cwd: "/x", now: NOW });
    expect(text.length).toBeLessThan(EXPORT_MAX_CHARS + 200);
    expect(text).toContain("export cut at");
  });

  test("an empty session still produces a readable header", () => {
    const text = buildExportText({ entries: [], cwd: "/x", now: NOW });
    expect(text).toContain("Qronos CLI conversation");
  });
});

describe("freeFileName", () => {
  test("keeps the name when it is free", () => {
    expect(freeFileName("a.txt", () => false)).toBe("a.txt");
  });

  test("adds -2, then -3", () => {
    const taken = new Set(["a.txt"]);
    expect(freeFileName("a.txt", (path) => taken.has(path))).toBe("a-2.txt");
    taken.add("a-2.txt");
    expect(freeFileName("a.txt", (path) => taken.has(path))).toBe("a-3.txt");
  });

  test("puts the number before the extension", () => {
    const taken = new Set(["notes.txt", "notes-2.txt"]);
    expect(freeFileName("notes.txt", (path) => taken.has(path))).toBe("notes-3.txt");
  });
});
