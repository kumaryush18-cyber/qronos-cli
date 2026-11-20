// Tests for the LSP client, edit application and the `lsp` tool.
//
// No language server is installed in CI, so the tool is driven through a stub
// client. That is the point: the risky parts are the framing, the offset maths
// and the "server is missing" message — none of which need a real server.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { encodeMessage, parseFrames } from "../src/lsp/client";
import {
  applyTextEdits,
  collectEdits,
  pathToUri,
  positionToOffset,
  uriToPath,
  type TextEdit,
} from "../src/lsp/edits";
import {
  bundledTypescriptServer,
  findOnPath,
  findTsserverPath,
  initializeOptionsFor,
  LANGUAGE_SERVERS,
  resolveServerForPath,
} from "../src/lsp/servers";
import {
  countEdits,
  findReferences,
  hoverContents,
  languageIdFor,
  runLspAction,
  waitForDiagnostics,
  wordAt,
} from "../src/lsp/tool";

describe("JSON-RPC framing", () => {
  test("encodes a length header and parses it back", () => {
    const encoded = encodeMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect(encoded.startsWith("Content-Length: ")).toBe(true);
    const { messages, rest } = parseFrames(encoded);
    expect(messages.length).toBe(1);
    expect(messages[0].method).toBe("initialize");
    expect(rest).toBe("");
  });

  test("waits for the rest of a message split across chunks", () => {
    const encoded = encodeMessage({ jsonrpc: "2.0", id: 2, result: { ok: true } });
    const cut = Math.floor(encoded.length / 2);
    expect(parseFrames(encoded.slice(0, cut)).messages).toEqual([]);
    const { messages } = parseFrames(encoded);
    expect(messages[0].result).toEqual({ ok: true });
  });

  test("parses two messages arriving together", () => {
    const buffer =
      encodeMessage({ jsonrpc: "2.0", method: "a" }) + encodeMessage({ jsonrpc: "2.0", method: "b" });
    expect(parseFrames(buffer).messages.map((m) => m.method)).toEqual(["a", "b"]);
  });

  test("a broken frame is skipped, not fatal", () => {
    const buffer = "Content-Length: 4\r\n\r\n{oops" + encodeMessage({ jsonrpc: "2.0", method: "ok" });
    const { messages } = parseFrames(buffer);
    expect(messages.map((m) => m.method)).toContain("ok");
  });
});

describe("edit application", () => {
  test("positionToOffset handles multi-line text and out-of-range positions", () => {
    const text = "abc\ndef\nghi";
    expect(positionToOffset(text, { line: 0, character: 0 })).toBe(0);
    expect(positionToOffset(text, { line: 1, character: 1 })).toBe(5);
    expect(positionToOffset(text, { line: 99, character: 0 })).toBe(text.length);
    expect(positionToOffset(text, { line: 0, character: 99 })).toBe(3);
  });

  test("applies several edits back-to-front without shifting each other", () => {
    const text = "one two three";
    const edits: TextEdit[] = [
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: "ONE" },
      { range: { start: { line: 0, character: 8 }, end: { line: 0, character: 13 } }, newText: "THREE" },
    ];
    expect(applyTextEdits(text, edits)).toBe("ONE two THREE");
  });

  test("collapses a duplicate edit a server sends twice", () => {
    const text = "alpha";
    const edit: TextEdit = { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, newText: "beta" };
    expect(applyTextEdits(text, [edit, edit])).toBe("beta");
  });

  test("a multi-line insert keeps the following lines", () => {
    const text = "import a from 'a';\nconst x = 1;\n";
    const edits: TextEdit[] = [
      {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        newText: "import b from 'b';\n",
      },
    ];
    expect(applyTextEdits(text, edits)).toBe("import b from 'b';\nimport a from 'a';\nconst x = 1;\n");
  });

  test("collectEdits understands changes and documentChanges", () => {
    const edits = collectEdits({
      changes: { "file:///a.ts": [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: "x" }] },
      documentChanges: [
        {
          textDocument: { uri: "file:///b.ts" },
          edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: "y" }],
        },
      ],
    });
    expect(edits.size).toBe(2);
  });

  test("uri <-> path round-trips", () => {
    const dir = mkdtempSync(join(tmpdir(), "qronos-lsp-"));
    const path = join(dir, "a.ts");
    expect(uriToPath(pathToUri(path))).toBe(path);
  });
});

describe("server discovery", () => {
  test("an unknown extension explains itself", () => {
    expect(resolveServerForPath("notes.txt").reason).toContain("no language server configured");
  });

  test("a missing binary gives the install command", () => {
    // TypeScript is bundled with the CLI, so use a language that is not.
    const result = resolveServerForPath("a.py", { PATH: "" });
    expect(result.reason).toContain("pyright");
    expect(result.reason).toContain("npm install -g");
  });

  test("finds a binary on PATH", () => {
    const dir = mkdtempSync(join(tmpdir(), "qronos-bin-"));
    writeFileSync(join(dir, "typescript-language-server"), "#!/bin/sh\n", { mode: 0o755 });
    expect(findOnPath("typescript-language-server", { PATH: dir })).toBe(join(dir, "typescript-language-server"));
    expect(resolveServerForPath("a.ts", { PATH: dir }).server?.spec.name).toBe("typescript-language-server");
  });

  test("language ids are right for the common extensions", () => {
    expect(languageIdFor("a.tsx")).toBe("typescriptreact");
    expect(languageIdFor("a.py")).toBe("python");
    expect(languageIdFor("a.unknown")).toBe("plaintext");
  });
});

describe("runLspAction with a stub server", () => {
  const fakeServer = {
    diagnosticsWaitMs: 50,
    resolveServer: () => ({
      server: {
        spec: { name: "fake", command: "fake-ls", args: [], extensions: [".ts"], install: "npx fake" },
        command: "fake-ls",
      },
    }),
  };

  function stub(responses: Record<string, unknown>, diagnostics: Record<string, unknown[]> = {}) {
    const calls: { method: string; params: unknown }[] = [];
    return {
      calls,
      client: {
        async request(method: string) {
          calls.push({ method, params: undefined });
          return responses[method] ?? null;
        },
        notify(method: string) {
          calls.push({ method, params: undefined });
        },
        outsideDiagnostics(uri: string) {
          return diagnostics[uri] ?? [];
        },
        hasPublishedDiagnostics(uri: string) {
          return Object.prototype.hasOwnProperty.call(diagnostics, uri);
        },
        dispose() {},
      },
    };
  }

  function workspace(files: Record<string, string>) {
    const dir = mkdtempSync(join(tmpdir(), "qronos-lsp-tool-"));
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, name)), { recursive: true });
      writeFileSync(join(dir, name), content, "utf8");
    }
    return dir;
  }

  test("rename_file rewrites the importing file and moves the file", async () => {
    const dir = workspace({
      "button.ts": "export const Button = 1;\n",
      "app.ts": "import { Button } from './button';\n",
    });
    const { client, calls } = stub({
      "workspace/willRenameFiles": {
        changes: {
          [pathToUri(join(dir, "app.ts"))]: [
            {
              range: { start: { line: 0, character: 23 }, end: { line: 0, character: 33 } },
              // The edit replaces `'./button'` including both quotes.
              newText: "'./ui/button'",
            },
          ],
        },
      },
    });

    const result = await runLspAction(
      { action: "rename_file", from: "button.ts", to: "ui/button.ts" },
      {
        cwd: () => dir,
        getClient: async () => client,
        ...fakeServer,
      },
    );

    expect(result.isError).toBeFalsy();
    expect(readFileSync(join(dir, "app.ts"), "utf8")).toBe("import { Button } from './ui/button';\n");
    expect(existsSync(join(dir, "ui/button.ts"))).toBe(true);
    expect(calls.some((call) => call.method === "workspace/willRenameFiles")).toBe(true);
  });

  test("rename applies every edit the server returns", async () => {
    const dir = workspace({ "a.ts": "const fetchUser = 1;\nfetchUser();\n" });
    const uri = pathToUri(join(dir, "a.ts"));
    const { client } = stub({
      "textDocument/rename": {
        changes: {
          [uri]: [
            { range: { start: { line: 0, character: 6 }, end: { line: 0, character: 15 } }, newText: "loadUser" },
            { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 9 } }, newText: "loadUser" },
          ],
        },
      },
    });

    const result = await runLspAction(
      { action: "rename", file: "a.ts", line: 1, column: 7, new_name: "loadUser" },
      { cwd: () => dir, getClient: async () => client, ...fakeServer },
    );

    expect(result.isError).toBeFalsy();
    expect(readFileSync(join(dir, "a.ts"), "utf8")).toBe("const loadUser = 1;\nloadUser();\n");
  });

  test("rename with no edits is reported as a failure, not success", async () => {
    const dir = workspace({ "a.ts": "x\n" });
    const { client } = stub({ "textDocument/rename": null });
    const result = await runLspAction(
      { action: "rename", file: "a.ts", line: 1, column: 1, new_name: "y" },
      { cwd: () => dir, getClient: async () => client, ...fakeServer },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("no edits");
  });

  test("diagnostics are formatted with the line number", async () => {
    const dir = workspace({ "a.ts": "const x: number = 'nope';\n" });
    const uri = pathToUri(join(dir, "a.ts"));
    const { client } = stub(
      {},
      { [uri]: [{ message: "Type 'string' is not assignable to type 'number'", range: { start: { line: 0 } } }] },
    );
    const result = await runLspAction(
      { action: "diagnostics", file: "a.ts" },
      { cwd: () => dir, getClient: async () => client, ...fakeServer },
    );
    expect(result.content[0].text).toContain("a.ts:1:");
    expect(result.content[0].text).toContain("not assignable");
  });

  test("diagnostics with nothing to report say so", async () => {
    const dir = workspace({ "a.ts": "const x = 1;\n" });
    const { client } = stub({}, { [`file://${dir}/a.ts`]: [] });
    const result = await runLspAction(
      { action: "diagnostics", file: "a.ts" },
      { cwd: () => dir, getClient: async () => client, ...fakeServer },
    );
    expect(result.content[0].text).toContain("no diagnostics");
  });

  test("a silent compiler is not the same as a clean file", async () => {
    const dir = workspace({ "a.ts": "const x = 1;\n" });
    const { client } = stub({});
    const result = await runLspAction(
      { action: "diagnostics", file: "a.ts" },
      { cwd: () => dir, getClient: async () => client, ...fakeServer, diagnosticsWaitMs: 40 },
    );
    expect(result.content[0].text).toContain("no answer from the compiler");
    expect(result.content[0].text).not.toContain("no diagnostics");
  });

  test("a stale publish is not reused for freshly opened content", async () => {
    const dir = workspace({ "a.ts": "const x: number = \"oops\";\n" });
    const uri = `file://${dir}/a.ts`;
    const state: { items: unknown[] | undefined } = { items: [] };
    const client = {
      async request() {
        return null;
      },
      notify() {},
      outsideDiagnostics() {
        return state.items ?? [];
      },
      hasPublishedDiagnostics() {
        return state.items !== undefined;
      },
      clearDiagnostics() {
        // The tool asks for a fresh answer, so the old one is dropped.
        state.items = undefined;
      },
      dispose() {},
    };

    const result = await runLspAction(
      { action: "diagnostics", file: "a.ts" },
      { cwd: () => dir, getClient: async () => client, ...fakeServer, diagnosticsWaitMs: 40 },
    );

    expect(result.content[0].text).toContain("no answer from the compiler");
  });

  test("hover returns the type text", async () => {
    const dir = workspace({ "a.ts": "const x = 1;\n" });
    const { client } = stub({ "textDocument/hover": { contents: { kind: "plaintext", value: "const x: number" } } });
    const result = await runLspAction(
      { action: "hover", file: "a.ts", line: 1, column: 7 },
      { cwd: () => dir, getClient: async () => client, ...fakeServer },
    );
    expect(result.content[0].text).toContain("number");
  });

  test("a missing server is a clear error, not a silent no-op", async () => {
    const dir = workspace({ "a.py": "x = 1\n" });
    const original = process.env.PATH;
    process.env.PATH = "";
    try {
      const result = await runLspAction(
        { action: "diagnostics", file: "a.py" },
        { cwd: () => dir, getClient: async () => ({}) as never },
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("npm install -g pyright");
    } finally {
      process.env.PATH = original;
    }
  });

  test("hoverContents flattens the three shapes LSP allows", () => {
    expect(hoverContents("text")).toBe("text");
    expect(hoverContents([{ value: "a" }, "b"])).toBe("a\nb");
    expect(hoverContents({ value: "c" })).toBe("c");
    expect(hoverContents(undefined)).toBe("");
  });
});

describe("tsserver discovery", () => {
  test("the project's own TypeScript wins over a global one", () => {
    const dir = mkdtempSync(join(tmpdir(), "qronos-ts-"));
    mkdirSync(join(dir, "node_modules", "typescript", "lib"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "typescript", "lib", "tsserver.js"), "// tsserver\n");
    expect(findTsserverPath(dir, { PATH: "" })).toBe(join(dir, "node_modules", "typescript", "lib", "tsserver.js"));
  });

  test("QRONOS_TSSERVER_PATH overrides everything", () => {
    const dir = mkdtempSync(join(tmpdir(), "qronos-ts-"));
    const explicit = join(dir, "custom-tsserver.js");
    writeFileSync(explicit, "// tsserver\n");
    expect(findTsserverPath("/nonexistent", { PATH: "", QRONOS_TSSERVER_PATH: explicit })).toBe(explicit);
  });

  test("the bundled compiler is the last resort, never a crash", () => {
    const found = findTsserverPath("/nonexistent-project", { PATH: "" });
    expect(found).toContain("typescript/lib/tsserver.js");
  });

  test("initialize options carry the tsserver path for TypeScript only", () => {
    const dir = mkdtempSync(join(tmpdir(), "qronos-ts-"));
    mkdirSync(join(dir, "node_modules", "typescript", "lib"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "typescript", "lib", "tsserver.js"), "// tsserver\n");
    const [ts, , rust] = LANGUAGE_SERVERS;
    expect(initializeOptionsFor(dir, ts, { PATH: "" })).toEqual({
      tsserver: { path: join(dir, "node_modules", "typescript", "lib", "tsserver.js") },
    });
    expect(initializeOptionsFor(dir, rust, { PATH: "" })).toBeUndefined();
  });
});

describe("waitForDiagnostics", () => {
  test("returns as soon as the compiler publishes something", async () => {
    let calls = 0;
    const client = {
      request: async () => null,
      notify: () => {},
      dispose: () => {},
      outsideDiagnostics: () => (++calls > 2 ? [{ message: "boom" }] : []),
    };
    const { items, settled } = await waitForDiagnostics(client, "file:///a.ts", 1000);
    expect(items.length).toBe(1);
    expect(settled).toBe(true);
    expect(calls).toBeGreaterThan(2);
  });

  test("gives up after the timeout instead of hanging", async () => {
    const client = {
      request: async () => null,
      notify: () => {},
      dispose: () => {},
      outsideDiagnostics: () => [],
    };
    const started = Date.now();
    const { items, settled } = await waitForDiagnostics(client, "file:///a.ts", 120);
    expect(items).toEqual([]);
    // Nothing arrived: the caller must be told "no answer", not "no problems".
    expect(settled).toBe(false);
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
  });
});

describe("bundled server", () => {
  test("qronos-cli ships its own TypeScript server and compiler", () => {
    expect(bundledTypescriptServer()).toBeString();
    expect(bundledTypescriptServer()!.endsWith("typescript-language-server/lib/cli.mjs")).toBe(true);
    // The bundled compiler is what initializeOptionsFor points at when the
    // project has no local TypeScript.
    expect(findTsserverPath("/nonexistent-project", { PATH: "" })).toContain("typescript/lib/tsserver.js");
  });

  test("with nothing on PATH the bundled entry is used via the node binary", () => {
    const resolved = resolveServerForPath("a.ts", { PATH: "" });
    expect(resolved.server?.command).toBe(process.execPath);
    expect(resolved.server?.args?.[0]).toContain("typescript-language-server");
  });

  test("a PATH install still wins over the bundled copy", () => {
    const dir = mkdtempSync(join(tmpdir(), "qronos-bin2-"));
    writeFileSync(join(dir, "typescript-language-server"), "#!/bin/sh\n", { mode: 0o755 });
    const resolved = resolveServerForPath("a.ts", { PATH: dir });
    expect(resolved.server?.command).toBe(join(dir, "typescript-language-server"));
    expect(resolved.server?.args).toBeUndefined();
  });
});

describe("relative paths", () => {
  function workspace(files: Record<string, string>) {
    const dir = mkdtempSync(join(tmpdir(), "qronos-lsp-rel-"));
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, name)), { recursive: true });
      writeFileSync(join(dir, name), content);
    }
    return dir;
  }
  const resolveServer = () => ({
    server: {
      spec: { name: "fake", command: "fake-ls", args: [], extensions: [".ts"], install: "npx fake" },
      command: "fake-ls",
    },
  });

  test("a relative file path is resolved against the working directory", async () => {
    const dir = workspace({ "app.ts": "const x: number = 1;\n" });
    const opened: string[] = [];
    const stub = {
      request: async (method: string, params: any) => {
        if (method === "textDocument/diagnostic") return { items: [] };
        if (method === "textDocument/hover") return null;
        opened.push(params?.textDocument?.uri ?? "");
        return null;
      },
      notify: (method: string, params: any) => {
        if (method === "textDocument/didOpen") opened.push(params.textDocument.uri);
      },
      dispose: () => {},
      outsideDiagnostics: () => [],
      onNotification: () => () => {},
    } as unknown as never;

    const result = await runLspAction(
      { action: "diagnostics", file: "app.ts" },
      { cwd: () => dir, diagnosticsWaitMs: 30, getClient: async () => stub, resolveServer },
    );

    expect(result.isError).toBeFalsy();
    const uri = opened.find((value) => value.endsWith("app.ts"));
    expect(uri).toContain("/app.ts");
    expect(uri!.startsWith("file:///")).toBe(true);
  });

  test("a relative destination is resolved too, so the move lands inside the project", async () => {
    const dir = workspace({ "a.ts": "export const a = 1;\n" });
    const stub = {
      request: async () => [],
      notify: () => {},
      dispose: () => {},
      outsideDiagnostics: () => [],
      onNotification: () => () => {},
    } as unknown as never;

    const result = await runLspAction(
      { action: "rename_file", from: "a.ts", to: "nested/a.ts" },
      { cwd: () => dir, getClient: async () => stub, resolveServer },
    );

    expect(result.isError).toBeFalsy();
    expect(existsSync(join(dir, "nested", "a.ts"))).toBe(true);
    expect(existsSync(join(dir, "a.ts"))).toBe(false);
  });
});

describe("rename safety net", () => {
  test("wordAt reads the identifier under the cursor", () => {
    const text = "import { loadUser } from \"./user\";\n";
    expect(wordAt(text, 0, 10)).toBe("loadUser");
    expect(wordAt(text, 0, 0)).toBe("import");
    // Position on a space or punctuation is not a symbol.
    expect(wordAt(text, 0, 6)).toBeUndefined();
    expect(wordAt(text, 9, 0)).toBeUndefined();
  });

  test("countEdits understands both edit shapes", () => {
    expect(countEdits(null)).toBe(0);
    expect(
      countEdits({
        changes: {
          "file:///a.ts": [
            { range: at(0, 0), newText: "x" },
            { range: at(1, 0), newText: "y" },
          ],
        },
      }),
    ).toBe(2);
    expect(countEdits({ documentChanges: [{ textDocument: { uri: "file:///a.ts" }, edits: [] }] })).toBe(1);
  });

  function at(line: number, character: number) {
    return { start: { line, character }, end: { line, character: character + 1 } };
  }

  test("findReferences lists the files that still use the old name", () => {
    const dir = mkdtempSync(join(tmpdir(), "qronos-refs-"));
    mkdirSync(join(dir, "src"), { recursive: true });
    mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(dir, "src", "user.ts"), "export function loadUser() {}\n");
    writeFileSync(join(dir, "src", "app.ts"), 'import { loadUser } from "./user";\n');
    writeFileSync(join(dir, "src", "other.ts"), "export const unrelated = 1;\n");
    writeFileSync(join(dir, "node_modules", "pkg", "index.js"), "loadUser();\n");

    const found = findReferences(join(dir, "src", "user.ts"), "loadUser", dir);
    expect(found).toContain("src/app.ts");
    expect(found).not.toContain("src/other.ts");
    // The file that was renamed is not a leftover.
    expect(found).not.toContain("src/user.ts");
    // Dependencies are not checked.
    expect(found.some((path) => path.includes("node_modules"))).toBe(false);
  });

  test("a rename that leaves an importer behind says so", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qronos-left-"));
    writeFileSync(join(dir, "user.ts"), "export function loadUser() {}\n");
    writeFileSync(join(dir, "app.ts"), 'import { loadUser } from "./user";\n');
    const uri = `file://${dir}/user.ts`;

    // The server edits only the opened file — exactly the failure seen with a
    // real typescript-language-server that has not loaded the project yet.
    const stubClient = {
      async request(method: string) {
        if (method === "textDocument/rename") {
          return {
            changes: {
              [uri]: [{ range: { start: { line: 0, character: 16 }, end: { line: 0, character: 24 } }, newText: "findUser" }],
            },
          };
        }
        return null;
      },
      notify() {},
      outsideDiagnostics() {
        return [];
      },
      hasPublishedDiagnostics() {
        return true;
      },
      dispose() {},
    };

    const result = await runLspAction(
      { action: "rename", file: "user.ts", line: 1, column: 17, new_name: "findUser" },
      { cwd: () => dir, getClient: async () => stubClient, ...fakeServerForRename() },
    );

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("renamed loadUser -> findUser");
    expect(result.content[0].text).toContain("WARNING");
    expect(result.content[0].text).toContain("app.ts");
  });
});

function fakeServerForRename() {
  return {
    resolveServer: () => ({
      server: {
        spec: { name: "fake", command: "fake-ls", args: [], extensions: [".ts"], install: "npx fake" },
        command: "fake-ls",
      },
    }),
  };
}

describe("late answers", () => {
  const fakeServer = fakeServerForRename();

  test("an empty publish followed by a real error is reported as the error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qronos-late-"));
    writeFileSync(join(dir, "a.ts"), 'const n: number = "x";\n');
    const uri = `file://${dir}/a.ts`;
    let items: unknown[] = [];
    let version = 0;

    const client = {
      async request() {
        return null;
      },
      notify() {},
      outsideDiagnostics() {
        return items;
      },
      hasPublishedDiagnostics() {
        return version > 0;
      },
      publishedVersion() {
        return version;
      },
      clearDiagnostics() {
        items = [];
        version = 0;
      },
      dispose() {},
    };

    // First a clean answer (what tsserver sends before it has type-checked),
    // then the real one 200ms later.
    setTimeout(() => {
      version = 1;
      items = [];
    }, 30);
    setTimeout(() => {
      version = 2;
      items = [{ message: "Type 'string' is not assignable to type 'number'.", range: { start: { line: 0 } } }];
    }, 230);

    const result = await runLspAction(
      { action: "diagnostics", file: "a.ts" },
      { cwd: () => dir, getClient: async () => client, ...fakeServer, diagnosticsWaitMs: 3000 },
    );

    expect(result.content[0].text).toContain("not assignable to type");
  });

  test("a clean file stays clean, but only after the quiet window", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qronos-clean-"));
    writeFileSync(join(dir, "a.ts"), "const n = 1;\n");
    let version = 0;
    const client = {
      async request() {
        return null;
      },
      notify() {},
      outsideDiagnostics() {
        return [];
      },
      hasPublishedDiagnostics() {
        return version > 0;
      },
      publishedVersion() {
        return version;
      },
      clearDiagnostics() {},
      dispose() {},
    };
    setTimeout(() => {
      version = 1;
    }, 30);

    const result = await runLspAction(
      { action: "diagnostics", file: "a.ts" },
      { cwd: () => dir, getClient: async () => client, ...fakeServer, diagnosticsWaitMs: 3000 },
    );
    expect(result.content[0].text).toContain("no diagnostics");
  });
});
