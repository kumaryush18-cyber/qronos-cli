import { describe, expect, test } from "bun:test";
import {
  cardTitle,
  commandFromArgs,
  decideToolUse,
  grantKeys,
  grantLabel,
  hasGrant,
  isInsideProject,
  isReadOnlyCommand,
  pathFromArgs,
  projectDir,
  readToolFacts,
  refusalReason,
} from "../src/workflow-permissions";
import type { ToolFacts } from "../src/workflow-permissions";

const cwd = "/work/project";

const facts = (overrides: Partial<ToolFacts> = {}): ToolFacts => ({
  kind: "read",
  insideProject: true,
  dangerous: false,
  summary: "read x",
  ...overrides,
});

describe("reading a tool call", () => {
  test("a read tool is a read", () => {
    expect(readToolFacts({ name: "read", args: { path: "src/a.ts" }, cwd }).kind).toBe("read");
  });

  test("a write tool is a write", () => {
    expect(readToolFacts({ name: "edit", args: { path: "src/a.ts" }, cwd }).kind).toBe("write");
  });

  test("bash is a shell call, with the command", () => {
    const found = readToolFacts({ name: "bash", args: { command: "ls -la" }, cwd });
    expect(found.kind).toBe("shell");
    expect(found.command).toBe("ls -la");
    expect(found.summary).toContain("ls -la");
  });

  test("a destructive command is marked dangerous", () => {
    expect(readToolFacts({ name: "bash", args: { command: "rm -rf build" }, cwd }).dangerous).toBe(true);
  });

  test("a normal command is not dangerous", () => {
    expect(readToolFacts({ name: "bash", args: { command: "ls" }, cwd }).dangerous).toBe(false);
  });

  test("a write outside the project is marked dangerous", () => {
    const found = readToolFacts({ name: "write", args: { path: "../secret.txt" }, cwd });
    expect(found.insideProject).toBe(false);
    expect(found.dangerous).toBe(true);
    expect(found.summary).toContain("outside the project");
  });

  test("an unknown tool is other", () => {
    expect(readToolFacts({ name: "mcp__thing", args: {}, cwd }).kind).toBe("other");
  });

  test("a network tool is other and dangerous", () => {
    const found = readToolFacts({ name: "web_fetch", args: { url: "https://example.com" }, cwd });
    expect(found.kind).toBe("other");
    expect(found.dangerous).toBe(true);
  });

  test("a path argument is found under several names", () => {
    expect(pathFromArgs({ file_path: "a.ts" })).toBe("a.ts");
    expect(pathFromArgs({ filePath: "b.ts" })).toBe("b.ts");
    expect(pathFromArgs({})).toBeUndefined();
  });

  test("a command argument is found under several names", () => {
    expect(commandFromArgs({ cmd: "ls" })).toBe("ls");
    expect(commandFromArgs({})).toBeUndefined();
  });
});

describe("is a path inside the project", () => {
  test("a relative path is", () => {
    expect(isInsideProject("src/a.ts", cwd)).toBe(true);
  });

  test("climbing out with .. is not", () => {
    expect(isInsideProject("../a.ts", cwd)).toBe(false);
    expect(isInsideProject("src/../../a.ts", cwd)).toBe(false);
  });

  test("a path that only looks like climbing is fine", () => {
    expect(isInsideProject("src/../lib/a.ts", cwd)).toBe(true);
  });

  test("an absolute path inside the project is", () => {
    expect(isInsideProject("/work/project/src/a.ts", cwd)).toBe(true);
  });

  test("an absolute path outside is not", () => {
    expect(isInsideProject("/etc/passwd", cwd)).toBe(false);
  });

  test("a home path is not inside the project", () => {
    expect(isInsideProject("~/secrets.txt", cwd)).toBe(false);
  });
});

describe("a read-only command", () => {
  test("ls and grep and git status are read-only", () => {
    expect(isReadOnlyCommand("ls -la")).toBe(true);
    expect(isReadOnlyCommand("grep -r foo src")).toBe(true);
    expect(isReadOnlyCommand("git status")).toBe(true);
  });

  test("a shell operator makes it not read-only", () => {
    expect(isReadOnlyCommand("ls; rm -rf /")).toBe(false);
    expect(isReadOnlyCommand("cat f > out")).toBe(false);
    expect(isReadOnlyCommand("ls | xargs rm")).toBe(false);
  });

  test("an empty command is not read-only", () => {
    expect(isReadOnlyCommand("  ")).toBe(false);
  });
});

describe("the decision, mode by mode", () => {
  const read = facts({ kind: "read" });
  const write = facts({ kind: "write", path: "src/a.ts", summary: "write src/a.ts" });
  const shell = facts({ kind: "shell", command: "npm test", summary: "run: npm test" });
  const destructive = facts({ kind: "shell", command: "rm -rf build", dangerous: true, summary: "run: rm -rf build" });
  const outsideWrite = facts({ kind: "write", path: "../x", insideProject: false, dangerous: true, summary: "write ../x" });

  test("skip permissions never asks", () => {
    for (const one of [read, write, shell, destructive, outsideWrite]) {
      expect(decideToolUse("dangerously-skip-permissions", one)).toBe("allow");
    }
  });

  test("plan mode reads and refuses to change anything", () => {
    expect(decideToolUse("plan", read)).toBe("allow");
    expect(decideToolUse("plan", write)).toBe("refuse");
    expect(decideToolUse("plan", shell)).toBe("refuse");
  });

  test("plan mode allows a command that only reads", () => {
    expect(decideToolUse("plan", facts({ kind: "shell", command: "ls -la" }))).toBe("allow");
  });

  test("edit-automatically lets writes run and asks about the shell", () => {
    expect(decideToolUse("edit-automatically", write)).toBe("allow");
    expect(decideToolUse("edit-automatically", shell)).toBe("ask");
  });

  test("auto lets normal work run and stops at a destructive command", () => {
    expect(decideToolUse("auto", write)).toBe("allow");
    expect(decideToolUse("auto", shell)).toBe("allow");
    expect(decideToolUse("auto", destructive)).toBe("ask");
    expect(decideToolUse("auto", outsideWrite)).toBe("ask");
  });

  test("manual asks about everything but a read", () => {
    expect(decideToolUse("manual", read)).toBe("allow");
    expect(decideToolUse("manual", write)).toBe("ask");
    expect(decideToolUse("manual", shell)).toBe("ask");
  });
});

describe("grants", () => {
  const write = facts({ kind: "write", path: "src/deep/a.ts", summary: "write src/deep/a.ts" });

  test("a grant for a directory covers files under it", () => {
    expect(hasGrant(write, new Set(["path:write:src"]))).toBe(true);
  });

  test("a grant for a directory does not cover a look-alike directory", () => {
    expect(hasGrant(write, new Set(["path:write:srcx"]))).toBe(false);
  });

  test("a grant for the tool covers every path", () => {
    expect(hasGrant(write, new Set(["all:write"]))).toBe(true);
  });

  test("a grant for one tool does not cover another", () => {
    expect(hasGrant(write, new Set(["all:shell"]))).toBe(false);
  });

  test("a grant turns an ask into an allow", () => {
    expect(decideToolUse("manual", write, new Set(["path:write:src"]))).toBe("allow");
  });

  test("a grant cannot overrule plan mode", () => {
    // Plan mode is a promise about the whole session, not a question.
    expect(decideToolUse("plan", write, new Set(["all:write"]))).toBe("refuse");
  });

  test("the keys a grant is stored under are the tool and its directory", () => {
    expect(grantKeys(write)).toEqual(["all:write", "path:write:src/deep"]);
  });

  test("a shell grant is the tool only", () => {
    expect(grantKeys(facts({ kind: "shell", command: "ls" }))).toEqual(["all:shell"]);
  });

  test("a directory is project-relative and normalised", () => {
    expect(projectDir("src/a.ts")).toBe("src");
    expect(projectDir("a.ts")).toBe(".");
    expect(projectDir("../x")).toBeUndefined();
    expect(projectDir("/etc/passwd")).toBeUndefined();
  });
});

describe("the words on the card", () => {
  test("a shell call is titled Bash command", () => {
    expect(cardTitle(facts({ kind: "shell" }))).toBe("Bash command");
  });

  test("a write is titled Write file", () => {
    expect(cardTitle(facts({ kind: "write" }))).toBe("Write file");
  });

  test("the second answer names the directory when there is one", () => {
    expect(grantLabel(facts({ kind: "write", path: "src/a.ts" }))).toBe("Yes, allow writes under src/ for this run");
  });

  test("the second answer stays general without a directory", () => {
    expect(grantLabel(facts({ kind: "shell" }))).toBe("Yes, allow shell commands for this run");
  });

  test("a refusal says why, in words the subagent can use", () => {
    expect(refusalReason("plan", facts({ kind: "write", summary: "write a" }))).toContain("plan mode");
    expect(refusalReason("manual", facts({ kind: "write", summary: "write a" }))).toContain("did not approve");
  });
});
