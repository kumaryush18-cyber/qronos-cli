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
import { findOnPath, findTsserverPath, initializeOptionsFor, LANGUAGE_SERVERS, resolveServerForPath } from "../src/lsp/servers";
import { hoverContents, languageIdFor, runLspAction, waitForDiagnostics } from "../src/lsp/tool";

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
    const result = resolveServerForPath("a.ts", { PATH: "" });
    expect(result.reason).toContain("typescript-language-server");
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
    const { client } = stub({});
    const result = await runLspAction(
      { action: "diagnostics", file: "a.ts" },
      { cwd: () => dir, getClient: async () => client, ...fakeServer },
    );
    expect(result.content[0].text).toContain("no diagnostics");
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
    const dir = workspace({ "a.ts": "x\n" });
    const original = process.env.PATH;
    process.env.PATH = "";
    try {
      const result = await runLspAction(
        { action: "diagnostics", file: "a.ts" },
        { cwd: () => dir, getClient: async () => ({}) as never },
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("npm install -g");
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

  test("no TypeScript anywhere is simply undefined", () => {
    expect(findTsserverPath("/nonexistent", { PATH: "" })).toBeUndefined();
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
    const items = await waitForDiagnostics(client, "file:///a.ts", 1000);
    expect(items.length).toBe(1);
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
    const items = await waitForDiagnostics(client, "file:///a.ts", 120);
    expect(items).toEqual([]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
  });
});
