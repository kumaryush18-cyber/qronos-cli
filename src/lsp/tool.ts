// The `lsp` tool: ask the language server instead of guessing.
//
// Four actions, each solving a real failure the agent hits:
//   rename        rename a symbol; every reference in the project follows
//   rename_file   move a file; imports are rewritten by TypeScript itself
//   diagnostics   read the compiler's view of a file after a change
//   hover         the type of an expression, without running anything
//
// Servers are started lazily, one per server spec, and killed on shutdown. If a
// server is missing the tool answers with the install command — it never pretends
// to have worked.
import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { LspClient, type LspClientOptions } from "./client";
import { applyTextEdits, collectEdits, pathToUri, uriToPath, type WorkspaceEdit } from "./edits";
import { initializeOptionsFor, resolveServerForPath, serverArgs, type ResolvedServer } from "./servers";

export const LSP_TOOL_NAME = "lsp";

/**
 * How long to wait for the compiler to publish diagnostics for a freshly opened
 * file. The first request in a session pays for loading the whole project
 * (measured at ~2.5 s on a small repo), later ones answer immediately.
 */
export const DIAGNOSTICS_WAIT_MS = 5000;

export const LSP_PARAMS = Type.Object({
  action: Type.Union([
    Type.Literal("rename"),
    Type.Literal("rename_file"),
    Type.Literal("diagnostics"),
    Type.Literal("hover"),
  ]),
  file: Type.Optional(Type.String({ description: "File to operate on (rename, diagnostics, hover)" })),
  line: Type.Optional(Type.Number({ description: "1-based line (rename, hover)" })),
  column: Type.Optional(Type.Number({ description: "1-based column (rename, hover)" })),
  new_name: Type.Optional(Type.String({ description: "New symbol name (rename)" })),
  from: Type.Optional(Type.String({ description: "Current path (rename_file)" })),
  to: Type.Optional(Type.String({ description: "New path (rename_file)" })),
});

export interface LspToolDeps {
  cwd: () => string;
  /** Test seam: replace the real client with a stub. */
  startClient?: (options: LspClientOptions) => Promise<LspClientLike>;
  /** Test seam for the file write path. */
  writeFile?: (path: string, content: string) => void;
  readFile?: (path: string) => string;
  renameFile?: (from: string, to: string) => void;
  /** Test seam: which server to use for a path (defaults to PATH discovery). */
  resolveServer?: (path: string) => { server?: ResolvedServer; reason?: string };
  /** How long to wait for compiler diagnostics (default DIAGNOSTICS_WAIT_MS). */
  diagnosticsWaitMs?: number;
}

/** The slice of LspClient the tool uses, so tests do not need a process. */
export interface LspClientLike {
  request(method: string, params: unknown, timeoutMs?: number): Promise<unknown>;
  notify(method: string, params: unknown): void;
  outsideDiagnostics(uri: string): unknown[];
  dispose(): void;
}

const LANGUAGE_IDS: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescriptreact",
  ".js": "javascript",
  ".jsx": "javascriptreact",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".rs": "rust",
  ".go": "go",
};

export function languageIdFor(path: string): string {
  const match = /\.[a-z]+$/i.exec(path);
  return (match && LANGUAGE_IDS[match[0].toLowerCase()]) || "plaintext";
}

export function createLspToolExtension(deps: LspToolDeps): ExtensionFactory {
  const clients = new Map<string, Promise<LspClientLike>>();

  const getClient = (server: ResolvedServer): Promise<LspClientLike> => {
    const key = `${server.command} ${server.spec.args.join(" ")}`;
    const existing = clients.get(key);
    if (existing) return existing;
    const start = deps.startClient ?? ((options) => LspClient.start(options));
    const created = start({
      command: server.command,
      args: serverArgs(server.spec),
      cwd: deps.cwd(),
      initializationOptions: initializeOptionsFor(deps.cwd(), server.spec),
    }).catch((error) => {
      clients.delete(key);
      throw error;
    });
    clients.set(key, created);
    return created;
  };

  return (qronos: ExtensionAPI) => {
    qronos.on("session_shutdown", async () => {
      for (const [, client] of clients) {
        try {
          (await client).dispose();
        } catch {
          // Already gone.
        }
      }
      clients.clear();
    });

    qronos.registerTool({
      name: LSP_TOOL_NAME,
      label: "Language server",
      description:
        "Ask the language server: rename a symbol across the project, move a file with imports updated, read compiler diagnostics, or get the type of an expression.",
      promptSnippet:
        "Rename symbols and files through the language server so imports and references stay correct",
      promptGuidelines: [
        "Prefer `lsp` rename_file over moving a file by hand: the language server rewrites the imports.",
        "After a rename, run `lsp` diagnostics on the touched files and fix anything it reports.",
      ],
      parameters: LSP_PARAMS,
      async execute(_toolCallId, params) {
        return runLspAction(params as LspParams, { ...deps, getClient });
      },
    });
  };
}

export interface LspParams {
  action: "rename" | "rename_file" | "diagnostics" | "hover";
  file?: string;
  line?: number;
  column?: number;
  new_name?: string;
  from?: string;
  to?: string;
}

interface RunDeps extends LspToolDeps {
  getClient: (server: ResolvedServer) => Promise<LspClientLike>;
}

const text = (value: string) => ({
  content: [{ type: "text" as const, text: value }],
  details: undefined,
  isError: false,
});
const fail = (value: string) => ({
  content: [{ type: "text" as const, text: `Error: ${value}` }],
  details: undefined,
  isError: true,
});

export async function runLspAction(params: LspParams, deps: RunDeps) {
  const cwd = deps.cwd();
  const read = deps.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  const write = deps.writeFile ?? ((path: string, content: string) => writeFileSync(path, content, "utf8"));
  const move = deps.renameFile ?? ((from: string, to: string) => renameSync(from, to));

  const targetPath = params.action === "rename_file" ? params.from : params.file;
  if (!targetPath) return fail("this action needs a file path");

  const discover = deps.resolveServer ?? ((path: string) => resolveServerForPath(path));
  const { server, reason } = discover(targetPath);
  if (!server) return fail(reason ?? "no language server available");

  let client: LspClientLike;
  try {
    client = await deps.getClient(server);
  } catch (error) {
    return fail((error as Error).message);
  }

  const absolute = targetPath.startsWith("/") ? targetPath : `${cwd}/${targetPath}`;
  const uri = pathToUri(absolute);

  if (params.action === "rename_file") {
    if (!params.to) return fail("rename_file needs `to`");
    const toAbsolute = params.to.startsWith("/") ? params.to : `${cwd}/${params.to}`;
    if (!existsSync(absolute)) return fail(`${targetPath} does not exist`);
    mkdirSync(dirname(toAbsolute), { recursive: true });

    // The server only knows about files someone opened. Without this the rename
    // succeeds and every import silently keeps pointing at the old path.
    client.notify("textDocument/didOpen", {
      textDocument: { uri, languageId: languageIdFor(targetPath), version: 1, text: read(absolute) },
    });

    const ask = () =>
      client.request("workspace/willRenameFiles", {
        files: [{ oldUri: uri, newUri: pathToUri(toAbsolute) }],
      }) as Promise<WorkspaceEdit | null>;

    let reply = await ask();
    if (!collectEdits(reply).size) {
      // The first request can race the server loading the project; one short
      // retry is cheap and turns "no edits" into the real answer.
      await new Promise((resolve) => setTimeout(resolve, 800));
      reply = await ask();
    }

    const edited = applyWorkspaceEdit(reply, { read, write });
    client.notify("textDocument/didClose", { textDocument: { uri } });
    move(absolute, toAbsolute);
    client.notify("workspace/didChangeWatchedFiles", {
      changes: [
        { uri, type: 3 },
        { uri: pathToUri(toAbsolute), type: 1 },
      ],
    });
    const summary = edited.length > 0 ? `updated imports in ${edited.join(", ")}` : "no import changes were needed";
    return text(`moved ${targetPath} -> ${params.to}; ${summary}`);
  }

  // Everything else needs the document open.
  if (!existsSync(absolute)) return fail(`${targetPath} does not exist`);
  const content = read(absolute);
  client.notify("textDocument/didOpen", {
    textDocument: { uri, languageId: languageIdFor(targetPath), version: 1, text: content },
  });

  if (params.action === "diagnostics") {
    // Diagnostics arrive asynchronously as a notification, so asking immediately
    // after didOpen returns "none" even for a file full of errors. Wait for the
    // notification, but never more than two seconds.
    const published = await waitForDiagnostics(client, uri, deps.diagnosticsWaitMs ?? DIAGNOSTICS_WAIT_MS);
    const pulled = (await client
      .request("textDocument/diagnostic", { textDocument: { uri } })
      .catch(() => null)) as { items?: unknown[] } | null;
    const items = (published.length > 0 ? published : pulled?.items ?? []) as {
      message?: string;
      severity?: number;
      range?: { start?: { line?: number } };
    }[];
    if (items.length === 0) return text(`${targetPath}: no diagnostics`);
    const lines = items.map((item) => {
      const line = (item.range?.start?.line ?? 0) + 1;
      return `${targetPath}:${line}: ${item.message ?? "(no message)"}`;
    });
    return text(lines.join("\n"));
  }

  if (params.action === "rename") {
    if (!params.new_name) return fail("rename needs `new_name`");
    if (!params.line || !params.column) return fail("rename needs 1-based `line` and `column`");
    const reply = (await client.request("textDocument/rename", {
      textDocument: { uri },
      position: { line: params.line - 1, character: params.column - 1 },
      newName: params.new_name,
    })) as WorkspaceEdit | null;
    const edited = applyWorkspaceEdit(reply, { read, write });
    if (edited.length === 0) return fail("the language server returned no edits (is the cursor on a renameable symbol?)");
    return text(`renamed to ${params.new_name}; updated ${edited.join(", ")}`);
  }

  // hover
  if (!params.line || !params.column) return fail("hover needs 1-based `line` and `column`");
  const hover = (await client.request("textDocument/hover", {
    textDocument: { uri },
    position: { line: params.line - 1, character: params.column - 1 },
  })) as { contents?: unknown } | null;
  const value = hoverContents(hover?.contents);
  return text(value || "no type information at that position");
}

/** Poll for published diagnostics until one arrives or the wait runs out. */
export async function waitForDiagnostics(client: LspClientLike, uri: string, timeoutMs: number): Promise<unknown[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const diagnostics = client.outsideDiagnostics(uri);
    if (diagnostics.length > 0 || Date.now() >= deadline) return diagnostics;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Write every file the server wants changed, returning the touched paths. */
export function applyWorkspaceEdit(
  edit: WorkspaceEdit | null | undefined,
  io: { read: (path: string) => string; write: (path: string, content: string) => void },
): string[] {
  const byFile = collectEdits(edit);
  const touched: string[] = [];
  for (const [uri, edits] of byFile) {
    const path = uriToPath(uri);
    let original: string;
    try {
      original = io.read(path);
    } catch {
      continue; // A file the server wants to edit but we cannot read: skip, do not crash.
    }
    const updated = applyTextEdits(original, edits);
    if (updated === original) continue;
    io.write(path, updated);
    touched.push(path);
  }
  return touched;
}

export function hoverContents(contents: unknown): string {
  if (typeof contents === "string") return contents.trim();
  if (Array.isArray(contents)) return contents.map((part) => hoverContents(part)).filter(Boolean).join("\n");
  if (contents && typeof contents === "object") {
    const value = (contents as { value?: unknown }).value;
    if (typeof value === "string") return value.trim();
  }
  return "";
}