import { describe, expect, test } from "bun:test";
import {
  COMMAND_MAX_CHARS,
  STEP_MAX_CHARS,
  cleanLine,
  commandPreview,
  stepHeading,
  stepTitle,
} from "../src/tool-step";

describe("cleanLine", () => {
  test("collapses newlines and runs of spaces into one line", () => {
    expect(cleanLine("run\n  the\t tests")).toBe("run the tests");
  });
  test("drops ANSI colour and OSC links", () => {
    expect(cleanLine("\u001b[31mred\u001b[39m text")).toBe("red text");
    expect(cleanLine("\u001b]8;;file:///tmp/a\u0007click\u001b]8;;\u0007")).toBe("click");
  });
  test("drops control characters", () => {
    expect(cleanLine("a\u0000b\u0007c")).toBe("a b c");
  });
  test("cuts with three dots at the cap", () => {
    const long = "x".repeat(STEP_MAX_CHARS + 20);
    const out = cleanLine(long);
    expect(out.length).toBe(STEP_MAX_CHARS);
    expect(out.endsWith("...")).toBe(true);
  });
  test("the cut never splits a colour escape in half", () => {
    const out = cleanLine(`${"\u001b[31m"}${"y".repeat(200)}`);
    expect(out.includes("\u001b")).toBe(false);
  });
  test("empty and blank input stays empty", () => {
    expect(cleanLine("")).toBe("");
    expect(cleanLine("   \n\t ")).toBe("");
  });
});

describe("commandPreview", () => {
  test("takes the first non-empty line", () => {
    expect(commandPreview("\n\n  npm test -- --watch=false\nrm -rf /")).toBe("npm test -- --watch=false");
  });
  test("a heredoc keeps only its first line", () => {
    expect(commandPreview("cat > a.py <<'EOF'\nprint(1)\nEOF")).toBe("cat > a.py <<'EOF'");
  });
  test("cuts long commands", () => {
    const out = commandPreview(`echo ${"z".repeat(300)}`);
    expect(out.length).toBe(COMMAND_MAX_CHARS);
    expect(out.endsWith("...")).toBe(true);
  });
  test("non-strings and blank commands give an empty string", () => {
    expect(commandPreview(undefined)).toBe("");
    expect(commandPreview({ command: "ls" })).toBe("");
    expect(commandPreview(" \n ")).toBe("");
  });
});

describe("stepTitle", () => {
  test("reads the model's description", () => {
    expect(stepTitle({ command: "ls", description: "List files in current directory" })).toBe(
      "List files in current directory",
    );
  });
  test("no description means no step", () => {
    expect(stepTitle({ command: "ls" })).toBeUndefined();
    expect(stepTitle({ command: "ls", description: 5 })).toBeUndefined();
    expect(stepTitle({ command: "ls", description: "   " })).toBeUndefined();
    expect(stepTitle(undefined)).toBeUndefined();
    expect(stepTitle("ls")).toBeUndefined();
  });
  test("a description that only repeats the command is dropped", () => {
    expect(stepTitle({ command: "npm test", description: "npm test" })).toBeUndefined();
    expect(stepTitle({ command: "npm test\nmore", description: " NPM TEST " })).toBeUndefined();
  });
  test("a multi-line description becomes one line", () => {
    expect(stepTitle({ command: "ls", description: "List files\nin the\ncurrent directory" })).toBe(
      "List files in the current directory",
    );
  });
});

describe("stepHeading", () => {
  test("returns both lines", () => {
    expect(stepHeading({ command: "git status", description: "Show working tree status" })).toEqual({
      title: "Show working tree status",
      command: "git status",
    });
  });
  test("a missing command still yields a title", () => {
    expect(stepHeading({ description: "Show working tree status" })).toEqual({
      title: "Show working tree status",
      command: "",
    });
  });
  test("no description means no heading at all", () => {
    expect(stepHeading({ command: "git status" })).toBeUndefined();
  });
});
