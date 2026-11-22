import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeFileName, saveDir, saveWorkflowScript } from "../src/workflow-save";

describe("safeFileName", () => {
  test("keeps letters, digits and dashes", () => {
    expect(safeFileName("analyze-src")).toBe("analyze-src");
  });

  test("turns spaces and punctuation into one dash", () => {
    expect(safeFileName("Audit every route in src/routes")).toBe("audit-every-route-in-src-routes");
  });

  test("trims dashes from both ends", () => {
    expect(safeFileName("  __weird__  ")).toBe("weird");
  });

  test("an empty name still makes a file name", () => {
    expect(safeFileName("", "workflow")).toBe("workflow");
    expect(safeFileName("///")).toBe("workflow");
  });

  test("a very long name is cut", () => {
    expect(safeFileName("a".repeat(200)).length).toBe(60);
  });

  test("windows-hostile characters never survive", () => {
    expect(safeFileName('a:b*c?d"e<f>g|h')).toBe("a-b-c-d-e-f-g-h");
  });
});

describe("saveDir", () => {
  test("lives inside the project, so git can keep it", () => {
    expect(saveDir("/repo")).toBe(join("/repo", ".qronos", "workflows"));
  });
});

describe("saveWorkflowScript", () => {
  const tmp = () => mkdtempSync(join(tmpdir(), "qronos-save-"));

  test("writes the script and returns the path", () => {
    const cwd = tmp();
    try {
      const saved = saveWorkflowScript({ cwd, name: "audit", script: "return 1" });
      expect(saved.path.endsWith(join(".qronos", "workflows", "audit.js"))).toBe(true);
      expect(saved.renamed).toBe(false);
      expect(readFileSync(saved.path, "utf8")).toBe("return 1\n");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("adds a final newline, and does not double one", () => {
    const cwd = tmp();
    try {
      const first = saveWorkflowScript({ cwd, name: "a", script: "return 1\n" });
      expect(readFileSync(first.path, "utf8")).toBe("return 1\n");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("never overwrites: the second save of the same name gets -2", () => {
    const cwd = tmp();
    try {
      const first = saveWorkflowScript({ cwd, name: "audit", script: "one" });
      const second = saveWorkflowScript({ cwd, name: "audit", script: "two" });
      expect(second.path).not.toBe(first.path);
      expect(second.renamed).toBe(true);
      expect(second.path.endsWith("audit-2.js")).toBe(true);
      expect(readFileSync(first.path, "utf8")).toBe("one\n");
      expect(readFileSync(second.path, "utf8")).toBe("two\n");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("three saves make three files", () => {
    const cwd = tmp();
    try {
      saveWorkflowScript({ cwd, name: "x", script: "1" });
      saveWorkflowScript({ cwd, name: "x", script: "2" });
      saveWorkflowScript({ cwd, name: "x", script: "3" });
      expect(readdirSync(join(cwd, ".qronos", "workflows")).sort()).toEqual(["x-2.js", "x-3.js", "x.js"]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("the directory is made when it is missing", () => {
    const cwd = tmp();
    try {
      saveWorkflowScript({ cwd, name: "deep", script: "1" });
      expect(readdirSync(join(cwd, ".qronos", "workflows"))).toHaveLength(1);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("seams replace the disk, so the naming rule is testable alone", () => {
    const written: string[] = [];
    const taken = new Set<string>();
    const saved = saveWorkflowScript({
      cwd: "/virtual",
      name: "Two Words",
      script: "x",
      exists: (path) => taken.has(path),
      mkdir: () => {},
      write: (path) => {
        if (written.length === 0) taken.add(path);
        written.push(path);
      },
    });
    expect(written).toHaveLength(1);
    expect(saved.path).toBe(join("/virtual", ".qronos", "workflows", "two-words.js"));
  });

  test("a write error reaches the caller, who turns it into a message", () => {
    expect(() =>
      saveWorkflowScript({
        cwd: "/virtual",
        name: "n",
        script: "x",
        exists: () => false,
        mkdir: () => {},
        write: () => {
          throw new Error("read-only");
        },
      }),
    ).toThrow("read-only");
  });
});
