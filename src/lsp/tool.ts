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
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
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
export const DIAGNOSTICS_WAIT_MS = 8000;
/** How long a rename waits for the project to load before asking for edits. */
export const PROJECT_LOAD_WAIT_MS = 4000;
/** How long the compiler must stay quiet before its answer is trusted. */
export const DIAGNOSTICS_QUIET_MS = 1200;

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
  /**
   * Working directory of the running session. It beats process.cwd(), because a
   * session can be started in one folder while the process runs in another, and
   * resolving "user.ts" against the wrong folder makes the tool look at a file
   * that does not exist.
   */
  sessionCwd?: () => string | undefined;
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
  /** True once the server published for this file, even with no problems. */
  hasPublishedDiagnostics?(uri: string): boolean;
  /** Forget a stale publish for this file. */
  clearDiagnostics?(uri: string): void;
  /** Publishes made so far for this file. */
  publishedVersion?(uri: string): number;
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
      // A bundled server is launched as `node <entry> --stdio`, so its own args
      // come first and the spec's args follow.
      args: [...(server.args ?? []), ...serverArgs(server.spec)],
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
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        return runLspAction(params as LspParams, {
          ...deps,
          cwd: () => ctx?.cwd || deps.sessionCwd?.() || deps.cwd(),
          getClient,
        });
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

  const requested = params.action === "rename_file" ? params.from : params.file;
  if (!requested) return fail("this action needs a file path");
  // A model will often pass "app.ts" instead of the absolute path it saw. Use
  // one absolute path for discovery, existence checks and the server URI, so a
  // relative path cannot be reported as "does not exist".
  const targetPath = isAbsolute(requested) ? requested : resolve(cwd, requested);

  // QRONOS_LSP_PATH narrows where servers are looked for. It exists so the
  // bundled copy can be proven to work without touching the machine's PATH.
  const discover =
    deps.resolveServer ??
    ((path: string) => {
      const lookupPath = process.env.QRONOS_LSP_PATH;
      const env = lookupPath ? { ...process.env, PATH: lookupPath } : process.env;
      return resolveServerForPath(path, env);
    });
  const { server, reason } = discover(targetPath);
  if (!server) return fail(reason ?? "no language server available");

  let client: LspClientLike;
  try {
    client = await deps.getClient(server);
  } catch (error) {
    return fail((error as Error).message);
  }

  const absolute = targetPath;
  const uri = pathToUri(absolute);

  if (params.action === "rename_file") {
    if (!params.to) return fail("rename_file needs `to`");
    const toAbsolute = isAbsolute(params.to) ? params.to : resolve(cwd, params.to);
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
  // The previous publish describes the previous content, so it must not be read
  // as the answer for the file as it is now.
  (client as { clearDiagnostics?: (uri: string) => void }).clearDiagnostics?.(uri);

  if (params.action === "diagnostics") {
    // Diagnostics arrive asynchronously as a notification, so asking immediately
    // after didOpen returns "none" even for a file full of errors. Wait for the
    // notification, but never more than two seconds.
    const { items: published, settled } = await waitForDiagnostics(
      client,
      uri,
      deps.diagnosticsWaitMs ?? DIAGNOSTICS_WAIT_MS,
    );
    // Pull diagnostics are only trusted when the server answers. Not every
    // server implements them (typescript-language-server 6 replies -32601), and
    // an unsupported pull must never be read as "no problems found".
    const pulled = settled
      ? null
      : ((await client.request("textDocument/diagnostic", { textDocument: { uri } }).catch(() => null)) as {
          items?: unknown[];
        } | null);
    const items = (published.length > 0 ? published : pulled?.items ?? []) as {
      message?: string;
      severity?: number;
      range?: { start?: { line?: number } };
    }[];
    if (items.length === 0 && !settled) {
      const seconds = Math.round((deps.diagnosticsWaitMs ?? DIAGNOSTICS_WAIT_MS) / 1000);
      return text(
        `${targetPath}: no answer from the compiler after ${seconds}s — it may still be loading the project. Run diagnostics again.`,
      );
    }
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
    // Loading the project takes a moment. A rename asked for before the project
    // is loaded only sees the open file, so the importers of the symbol are
    // silently missed. Asking for diagnostics first makes the compiler load the
    // whole project, and then the rename covers it.
    await waitForDiagnostics(client, uri, PROJECT_LOAD_WAIT_MS);

    const position = { line: params.line - 1, character: params.column - 1 };
    const requestRename = async () =>
      (await client.request("textDocument/rename", {
        textDocument: { uri },
        position,
        newName: params.new_name,
      })) as WorkspaceEdit | null;

    let reply = await requestRename();
    if (countEdits(reply) === 0) {
      // The first request pays for loading the project. Without a second try a
      // rename can come back with edits for the open file and none for the files
      // that import it.
      await new Promise((resolve) => setTimeout(resolve, 800));
      reply = await requestRename();
    }
    const oldName = wordAt(content, position.line, position.character);
    const edited = applyWorkspaceEdit(reply, { read, write });
    if (edited.length === 0) return fail("the language server returned no edits (is the cursor on a renameable symbol?)");

    // A rename that leaves an importer behind is worse than no rename: one file
    // changed, another now references a name that no longer exists. Say it.
    const leftovers = oldName && oldName !== params.new_name ? findReferences(absolute, oldName, cwd) : [];
    if (leftovers.length > 0) {
      return text(
        `renamed ${oldName} -> ${params.new_name}; updated ${edited.join(", ")}.\nWARNING: the old name is still used in ${leftovers.length} file(s): ${leftovers.join(", ")}. Fix those too.`,
      );
    }
    return text(`renamed ${oldName ?? "symbol"} -> ${params.new_name}; updated ${edited.join(", ")}`);
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

/**
 * Poll for published diagnostics.
 *
 * `settled` is false when nothing arrived before the deadline. The difference
 * matters: "no problems" and "the compiler has not answered yet" must not read
 * the same to the model.
 */
export async function waitForDiagnostics(
  client: LspClientLike,
  uri: string,
  timeoutMs: number,
): Promise<{ items: unknown[]; settled: boolean }> {
  const deadline = Date.now() + timeoutMs;
  // TypeScript sends a quick "syntax only" answer, often an empty one, and the
  // real type errors a moment later. Accepting the first publish would report a
  // broken file as clean, so a publish only counts once the server has been
  // quiet for a short while after it.
  const quietMs = Math.min(DIAGNOSTICS_QUIET_MS, Math.max(10, Math.floor(timeoutMs / 2)));
  let lastVersion = -1;
  let lastChangeAt = Date.now();
  for (;;) {
    const items = client.outsideDiagnostics(uri);
    if (items.length > 0) return { items, settled: true };

    const version =
      client.publishedVersion?.(uri) ?? (client.hasPublishedDiagnostics?.(uri) ? 1 : 0);
    const now = Date.now();
    if (version !== lastVersion) {
      lastVersion = version;
      lastChangeAt = now;
    }
    if (version > 0 && now - lastChangeAt >= quietMs) return { items, settled: true };
    if (now >= deadline) return { items, settled: false };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** How many text edits a rename reply carries. */
export function countEdits(edit: WorkspaceEdit | null | undefined): number {
  if (!edit) return 0;
  const changes = (edit as { changes?: Record<string, unknown[]> }).changes;
  if (changes) return Object.values(changes).reduce((total, list) => total + (list?.length ?? 0), 0);
  const documentChanges = (edit as { documentChanges?: unknown[] }).documentChanges;
  return documentChanges?.length ?? 0;
}

/** The identifier around a 0-based line/character, used to report leftovers. */
export function wordAt(text: string, line: number, character: number): string | undefined {
  const lines = text.split("\n");
  const target = lines[line];
  if (target === undefined) return undefined;
  const isWord = (ch: string) => /[A-Za-z0-9_$]/.test(ch);
  if (!isWord(target[character] ?? "")) return undefined;
  let start = character;
  let end = character;
  while (start > 0 && isWord(target[start - 1]!)) start--;
  while (end < target.length && isWord(target[end]!)) end++;
  return target.slice(start, end) || undefined;
}

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", ".next", "coverage"]);
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".py", ".rs", ".go"];

/** Files under cwd that still mention `name`, as project-relative paths. */
export function findReferences(renamedFile: string, name: string, cwd: string, limit = 6): string[] {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`\\b${escaped}\\b`);
  const found: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (found.length >= limit || depth > 8) return;
    let entries: { name: string; isDirectory: () => boolean }[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= limit) return;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full, depth + 1);
        continue;
      }
      if (full === renamedFile) continue;
      if (!SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) continue;
      try {
        if (statSync(full).size > 1_000_000) continue;
        if (pattern.test(readFileSync(full, "utf8"))) found.push(relative(cwd, full).replace(/\\/g, "/") || full);
      } catch {
        // A file we cannot read is not evidence either way.
      }
    }
  };
  walk(cwd, 0);
  return found;
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