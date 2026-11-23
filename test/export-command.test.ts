// /export, the command: the two ways in, and the promise that Esc saves nothing.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runExport, resolveTargetPath, EXPORT_CHOICES } from "../src/export-command";

const made: string[] = [];
const NOW = new Date(2026, 10, 23, 10, 48, 46);

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "qronos-export-"));
  made.push(dir);
  return dir;
}

afterEach(() => {
  while (made.length > 0) {
    const dir = made.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

const BRANCH = [
  { type: "message", message: { role: "user", content: "hi" } },
  { type: "message", message: { role: "assistant", content: [{ type: "text", text: "Hello!" }] } },
];

interface HostOptions {
  cwd: string;
  branch?: unknown[];
  choice?: string;
  hasSelect?: boolean;
}

function makeHost(options: HostOptions) {
  const notices: Array<{ message: string; type: string }> = [];
  const host = {
    cwd: options.cwd,
    model: { id: "claude-haiku-5.5" },
    sessionManager: {
      getBranch: () => options.branch ?? BRANCH,
      getSessionName: () => "demo session",
    },
    ui: {
      notify: (message: string, type = "info") => notices.push({ message, type }),
      ...(options.hasSelect === false
        ? {}
        : { select: async (_title: string, choices: string[]) => choices.includes(options.choice ?? "") ? options.choice : undefined }),
    },
  };
  return { host, notices };
}

describe("resolveTargetPath", () => {
  test("a bare name gets .txt", () => {
    expect(resolveTargetPath("/proj", "notes")).toBe("/proj/notes.txt");
  });

  test("a name with an extension is kept", () => {
    expect(resolveTargetPath("/proj", "notes.md")).toBe("/proj/notes.md");
  });

  test("an absolute path is used as it is", () => {
    expect(resolveTargetPath("/proj", "/tmp/x.txt")).toBe("/tmp/x.txt");
  });

  test("quotes around a name are dropped", () => {
    expect(resolveTargetPath("/proj", '"my notes"')).toBe("/proj/my notes.txt");
  });
});

describe("runExport with a file name", () => {
  test("writes plain text and says where", async () => {
    const cwd = project();
    const { host, notices } = makeHost({ cwd });
    await runExport("notes.txt", host, { now: () => NOW });
    const file = join(cwd, "notes.txt");
    expect(existsSync(file)).toBe(true);
    const body = readFileSync(file, "utf8");
    expect(body).toContain("❯ hi");
    expect(body).toContain("● Hello!");
    expect(notices[0]?.message).toContain(file);
  });

  test("a bare name is saved as .txt", async () => {
    const cwd = project();
    const { host } = makeHost({ cwd });
    await runExport("summary", host, { now: () => NOW });
    expect(existsSync(join(cwd, "summary.txt"))).toBe(true);
  });

  test("a second export never overwrites the first", async () => {
    const cwd = project();
    const first = makeHost({ cwd });
    await runExport("notes.txt", first.host, { now: () => NOW });
    const second = makeHost({ cwd });
    await runExport("notes.txt", second.host, { now: () => NOW });
    expect(existsSync(join(cwd, "notes.txt"))).toBe(true);
    expect(existsSync(join(cwd, "notes-2.txt"))).toBe(true);
    expect(second.notices[0]?.message).toContain("number was added");
  });

  test("nothing to export is a warning, and writes no file", async () => {
    const cwd = project();
    const { host, notices } = makeHost({ cwd, branch: [] });
    await runExport("notes.txt", host, { now: () => NOW });
    expect(existsSync(join(cwd, "notes.txt"))).toBe(false);
    expect(notices[0]?.type).toBe("warning");
    expect(notices[0]?.message).toContain("Nothing to export");
  });

  test("a disk error becomes a message, not a crash", async () => {
    const cwd = project();
    const { host, notices } = makeHost({ cwd });
    await runExport("notes.txt", host, {
      now: () => NOW,
      write: () => {
        throw new Error("disk full");
      },
    });
    expect(notices[0]?.type).toBe("error");
    expect(notices[0]?.message).toContain("disk full");
  });
});

describe("runExport with no argument", () => {
  test("the menu offers the two Claude choices", async () => {
    expect(EXPORT_CHOICES).toEqual(["Copy to clipboard", "Save to file"]);
  });

  test("choosing the clipboard copies the transcript", async () => {
    const cwd = project();
    const { host, notices } = makeHost({ cwd, choice: "Copy to clipboard" });
    let copied = "";
    await runExport("", host, {
      now: () => NOW,
      copy: async (text: string) => {
        copied = text;
        return { ok: true, how: "pbcopy" };
      },
    });
    expect(copied).toContain("❯ hi");
    expect(notices[0]?.message).toContain("clipboard");
  });

  test("a clipboard that refuses says what to do instead", async () => {
    const cwd = project();
    const { host, notices } = makeHost({ cwd, choice: "Copy to clipboard" });
    await runExport("", host, {
      now: () => NOW,
      copy: async () => ({ ok: false, how: "none" }),
    });
    expect(notices[0]?.type).toBe("warning");
    expect(notices[0]?.message).toContain("/export <file>");
  });

  test("Esc on the menu saves nothing and says nothing", async () => {
    const cwd = project();
    const { host, notices } = makeHost({ cwd, choice: "" });
    let copied = false;
    await runExport("", host, {
      now: () => NOW,
      copy: async () => {
        copied = true;
        return { ok: true, how: "pbcopy" };
      },
    });
    expect(copied).toBe(false);
    expect(notices.length).toBe(0);
  });

  test("Save to file opens the save screen with a prefilled name", async () => {
    const cwd = project();
    const { host } = makeHost({ cwd, choice: "Save to file" });
    let suggested = "";
    await runExport("", host, {
      now: () => NOW,
      askName: async (_ctx: unknown, name: string) => {
        suggested = name;
        return name;
      },
    });
    expect(suggested).toBe("2026-11-23-104846-hi.txt");
    expect(existsSync(join(cwd, suggested))).toBe(true);
  });

  test("Esc on the save screen writes no file", async () => {
    const cwd = project();
    const { host, notices } = makeHost({ cwd, choice: "Save to file" });
    await runExport("", host, { now: () => NOW, askName: async () => undefined });
    expect(notices.length).toBe(0);
    expect(readdirSafe(cwd)).toEqual([]);
  });

  test("a host without a menu is told how to export, not left guessing", async () => {
    const cwd = project();
    const { host, notices } = makeHost({ cwd, hasSelect: false });
    await runExport("", host, { now: () => NOW });
    expect(notices[0]?.message).toContain("/export <file>");
  });
});

function readdirSafe(dir: string): string[] {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require("node:fs").readdirSync(dir);
  } catch {
    return [];
  }
}
