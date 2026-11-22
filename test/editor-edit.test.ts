import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { editTextInEditor } from "../src/editor-edit";

/** A fake editor: a shell script that does something to the file it is given. */
function fakeEditor(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "qronos-editor-"));
  const file = join(dir, "editor.sh");
  writeFileSync(file, `#!/bin/sh\n${body}\n`, "utf8");
  chmodSync(file, 0o755);
  return file;
}

const saved = { VISUAL: process.env.VISUAL, EDITOR: process.env.EDITOR };

beforeEach(() => {
  delete process.env.VISUAL;
  delete process.env.EDITOR;
});

afterEach(() => {
  if (saved.VISUAL === undefined) delete process.env.VISUAL;
  else process.env.VISUAL = saved.VISUAL;
  if (saved.EDITOR === undefined) delete process.env.EDITOR;
  else process.env.EDITOR = saved.EDITOR;
});

describe("editing a piece of text in the user's editor", () => {
  test("with no editor set, the text is left alone", () => {
    expect(editTextInEditor("hello")).toBeUndefined();
  });

  test("what the editor writes is what comes back", () => {
    process.env.EDITOR = fakeEditor('printf "new words\\n" > "$1"');
    expect(editTextInEditor("old words")).toBe("new words\n");
  });

  test("an editor that fails leaves the text alone", () => {
    process.env.EDITOR = fakeEditor('echo "no" >&2; exit 1');
    expect(editTextInEditor("keep me")).toBeUndefined();
  });

  test("a file that was not changed is not a change", () => {
    process.env.EDITOR = fakeEditor('true "$1"');
    expect(editTextInEditor("same words")).toBeUndefined();
  });

  test("trailing whitespace alone is not a change", () => {
    process.env.EDITOR = fakeEditor('printf "same words\\n\\n" > "$1"');
    expect(editTextInEditor("same words")).toBeUndefined();
  });

  test("the file name is a hint the editor can use", () => {
    process.env.EDITOR = fakeEditor('basename "$1" > "$1"');
    expect(editTextInEditor("x", { fileName: "task.txt" })).toBe("task.txt\n");
  });

  test("VISUAL wins over EDITOR, the way the shell does it", () => {
    process.env.EDITOR = fakeEditor('printf "from editor\\n" > "$1"');
    process.env.VISUAL = fakeEditor('printf "from visual\\n" > "$1"');
    expect(editTextInEditor("x")).toBe("from visual\n");
  });

  test("an editor name that does not exist is not a crash", () => {
    process.env.EDITOR = "/nonexistent/editor-xyz";
    expect(editTextInEditor("x")).toBeUndefined();
  });

  test("an editor with arguments is split, not shelled", () => {
    // The flag arrives before the file, the way a real editor expects it.
    const script = fakeEditor('test "$1" = "--wait" || exit 1; shift; printf "arg\\n" > "$1"');
    process.env.EDITOR = `${script} --wait`;
    expect(editTextInEditor("x")).toBe("arg\n");
  });
});
