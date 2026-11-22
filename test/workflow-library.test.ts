import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  MAX_SCRIPTS,
  listSavedScripts,
  readSavedScript,
  resolveSavedScript,
  savedScriptLine,
  scriptDirFor,
  scriptProblem,
} from "../src/workflow-library";

const dir = "/project/.qronos/workflows";

/** A fake directory: names, sizes and times, with no disk at all. */
function fakeDir(files: Record<string, { size?: number; at?: number }>) {
  return {
    exists: () => true,
    readdir: () => Object.keys(files),
    stat: (path: string) => {
      const name = path.split("/").at(-1)!;
      const file = files[name];
      if (!file) throw new Error("no such file");
      return { size: file.size ?? 10, mtimeMs: file.at ?? 0 };
    },
  };
}

describe("the saved scripts", () => {
  test("they live in one place, inside the project", () => {
    expect(scriptDirFor("/project")).toBe(join("/project", ".qronos", "workflows"));
  });

  test("only .js files are scripts", () => {
    const io = fakeDir({ "a.js": {}, "notes.md": {}, "b.js": {} });
    expect(listSavedScripts(dir, io).map((script) => script.name)).toEqual(["a", "b"]);
  });

  test("the newest comes first", () => {
    const io = fakeDir({ "old.js": { at: 1_000 }, "new.js": { at: 9_000 } });
    expect(listSavedScripts(dir, io)[0]!.name).toBe("new");
  });

  test("two files written at the same moment are ordered by name, not by luck", () => {
    const io = fakeDir({ "b.js": { at: 5 }, "a.js": { at: 5 } });
    expect(listSavedScripts(dir, io).map((script) => script.name)).toEqual(["a", "b"]);
  });

  test("a directory that does not exist is an empty list, not an error", () => {
    expect(listSavedScripts(dir, { exists: () => false }).length).toBe(0);
  });

  test("a directory that cannot be read is an empty list too", () => {
    const io = { exists: () => true, readdir: () => {
      throw new Error("permission denied");
    } };
    expect(listSavedScripts(dir, io).length).toBe(0);
  });

  test("a file that vanishes between listing and measuring is skipped", () => {
    const io = fakeDir({ "gone.js": {} });
    io.stat = () => {
      throw new Error("gone");
    };
    expect(listSavedScripts(dir, io).length).toBe(0);
  });

  test("the list is capped, so a drawer of scripts is still a list", () => {
    const files: Record<string, { at?: number }> = {};
    for (let index = 0; index < MAX_SCRIPTS + 10; index += 1) files[`s${index}.js`] = { at: index };
    expect(listSavedScripts(dir, fakeDir(files)).length).toBe(MAX_SCRIPTS);
  });
});

describe("finding the script a word means", () => {
  const io = fakeDir({ "review.js": {}, "deep-scan.js": {} });

  test("the plain name works", () => {
    expect(resolveSavedScript(dir, "review", io)?.path).toBe(join(dir, "review.js"));
  });

  test("the file name works too", () => {
    expect(resolveSavedScript(dir, "review.js", io)?.name).toBe("review");
  });

  test("a name with capitals and spaces finds the slug on disk", () => {
    expect(resolveSavedScript(dir, "Deep Scan", io)?.name).toBe("deep-scan");
  });

  test("an unknown name is nothing, not a guess", () => {
    expect(resolveSavedScript(dir, "deploy", io)).toBeUndefined();
  });

  test("an empty word is nothing", () => {
    expect(resolveSavedScript(dir, "   ", io)).toBeUndefined();
  });
});

describe("reading a saved script", () => {
  test("the text comes back", () => {
    expect(readSavedScript("/x/a.js", { read: () => "await agent('hi');" })).toBe("await agent('hi');");
  });

  test("a file that cannot be read is undefined, not a crash", () => {
    expect(
      readSavedScript("/x/a.js", {
        read: () => {
          throw new Error("no");
        },
      }),
    ).toBeUndefined();
  });

  test("an empty file is a problem worth naming", () => {
    expect(scriptProblem("")).toBe("the file is empty");
    expect(scriptProblem("   \n\t ")).toBe("the file is empty");
  });

  test("a file that could not be read is a different problem", () => {
    expect(scriptProblem(undefined)).toBe("the file could not be read");
  });

  test("a real script has no problem", () => {
    expect(scriptProblem("await agent('x');")).toBeUndefined();
  });
});

describe("one line about a script", () => {
  const script = { name: "review", path: "/x/review.js", bytes: 900, updatedAt: 1_000 };

  test("it names the script and its size", () => {
    expect(savedScriptLine(script, 61_000)).toContain("review · 900 B");
  });

  test("a bigger file is in kilobytes", () => {
    expect(savedScriptLine({ ...script, bytes: 5_000 }, 61_000)).toContain("5 KB");
  });

  test("the age is in words a person uses", () => {
    expect(savedScriptLine(script, 30_000)).toContain("just now");
    expect(savedScriptLine({ ...script, updatedAt: 1_000 }, 1_000 + 5 * 60_000)).toContain("5m ago");
    expect(savedScriptLine({ ...script, updatedAt: 0 }, 3 * 3_600_000)).toContain("3h ago");
    expect(savedScriptLine({ ...script, updatedAt: 0 }, 2 * 86_400_000)).toContain("2d ago");
  });

  test("a file with no time still gets a line", () => {
    expect(savedScriptLine({ ...script, updatedAt: undefined }, 61_000)).toBe("review · 900 B");
  });
});
