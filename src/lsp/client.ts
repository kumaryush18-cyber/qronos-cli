// Minimal Language Server Protocol client.
//
// Why a language server at all: when the agent renames a file, the imports in
// every other file must change. TypeScript itself knows exactly which ones, and
// answers that question through LSP (`workspace/willRenameFiles`). Hand-editing
// those imports is the classic way to leave a project in a state where `tsc`
// fails and the user has to finish the job.
//
// No dependency: LSP/JSON-RPC over stdio is a length header plus JSON. The
// framing helpers are pure so they can be tested without spawning anything.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { pathToFileURL } from "node:url";

export interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export function encodeMessage(message: JsonRpcMessage): string {
  const body = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
}

/**
 * Pull complete messages out of a growing buffer. Returns what was parsed and
 * the unconsumed tail, so a header split across two chunks still works.
 */
export function parseFrames(buffer: string): { messages: JsonRpcMessage[]; rest: string } {
  const messages: JsonRpcMessage[] = [];
  let rest = buffer;

  for (;;) {
    const headerEnd = rest.indexOf("\r\n\r\n");
    if (headerEnd === -1) break;

    const header = rest.slice(0, headerEnd);
    const lengthMatch = /content-length:\s*(\d+)/i.exec(header);
    if (!lengthMatch) {
      // A malformed header cannot be recovered from; drop up to the next break.
      rest = rest.slice(headerEnd + 4);
      continue;
    }

    const length = Number(lengthMatch[1]);
    const bodyStart = headerEnd + 4;
    if (Buffer.byteLength(rest.slice(bodyStart), "utf8") < length) break; // wait for more

    const body = rest.slice(bodyStart, bodyStart + length);
    rest = rest.slice(bodyStart + length);
    try {
      messages.push(JSON.parse(body) as JsonRpcMessage);
    } catch {
      // A broken frame is skipped rather than killing the session.
    }
  }

  return { messages, rest };
}

export interface LspClientOptions {
  command: string;
  args?: string[];
  cwd: string;
  /** Passed to `initialize`; some servers (TypeScript) need it to find their compiler. */
  initializationOptions?: Record<string, unknown>;
  /** Milliseconds allowed for the initialize handshake and for each request. */
  timeoutMs?: number;
}

export class LspStartError extends Error {}

/** One server, one process, one conversation. */
export class LspClient {
  private nextId = 1;
  private buffer = "";
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private readonly diagnostics = new Map<string, unknown[]>();
  private readonly notificationHandlers: ((message: JsonRpcMessage) => void)[] = [];
  private disposed = false;

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly timeoutMs: number,
  ) {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onData(chunk));
    child.on("exit", () => this.failAll("the language server exited"));
  }

  static async start(options: LspClientOptions): Promise<LspClient> {
    const timeoutMs = options.timeoutMs ?? 5000;
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(options.command, options.args ?? [], {
        cwd: options.cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env },
      }) as ChildProcessWithoutNullStreams;
    } catch (error) {
      throw new LspStartError(`could not start ${options.command}: ${(error as Error).message}`);
    }

    const client = new LspClient(child, timeoutMs);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new LspStartError(`${options.command} did not respond in ${timeoutMs}ms`)), timeoutMs);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(new LspStartError(`could not start ${options.command}: ${error.message}`));
      });
      child.once("spawn", () => {
        clearTimeout(timer);
        resolve();
      });
    });

    await client.request("initialize", {
      processId: process.pid,
      rootUri: pathToFileURL(options.cwd).href,
      workspaceFolders: [{ uri: pathToFileURL(options.cwd).href, name: "workspace" }],
      ...(options.initializationOptions ? { initializationOptions: options.initializationOptions } : {}),
      capabilities: {
        workspace: {
          workspaceEdit: { documentChanges: true },
          didChangeWatchedFiles: { dynamicRegistration: true },
          workspaceFolders: true,
        },
        textDocument: {
          rename: { prepareSupport: false },
          hover: { contentFormat: ["plaintext"] },
          publishDiagnostics: { relatedInformation: false },
        },
      },
      clientInfo: { name: "qronos-cli" },
    });
    client.notify("initialized", {});
    return client;
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    const { messages, rest } = parseFrames(this.buffer);
    this.buffer = rest;
    for (const message of messages) this.dispatch(message);
  }

  private dispatch(message: JsonRpcMessage): void {
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const entry = this.pending.get(Number(message.id));
      if (!entry) return;
      clearTimeout(entry.timer);
      this.pending.delete(Number(message.id));
      if (message.error) entry.reject(new Error(`${message.error.code}: ${message.error.message}`));
      else entry.resolve(message.result);
      return;
    }

    // Server -> client notifications we care about.
    if (message.method === "textDocument/publishDiagnostics") {
      const params = message.params as { uri?: string; diagnostics?: unknown[] } | undefined;
      if (params?.uri) this.diagnostics.set(params.uri, params.diagnostics ?? []);
    }
    if (message.id !== undefined && message.method) {
      // A server request (e.g. workspace/configuration). Answer with null so the
      // server never hangs waiting for us.
      this.write({ jsonrpc: "2.0", id: message.id, result: null });
    }
    for (const handler of this.notificationHandlers) handler(message);
  }

  private write(message: JsonRpcMessage): void {
    if (this.disposed) return;
    try {
      this.child.stdin.write(encodeMessage(message));
    } catch {
      // The exit handler reports a dead server; a broken pipe here is not news.
    }
  }

  request(method: string, params: unknown, overrideTimeoutMs?: number): Promise<unknown> {
    const id = this.nextId++;
    const timeoutMs = overrideTimeoutMs ?? this.timeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  outsideDiagnostics(uri: string): unknown[] {
    return this.diagnostics.get(uri) ?? [];
  }

  onNotification(handler: (message: JsonRpcMessage) => void): () => void {
    this.notificationHandlers.push(handler);
    return () => {
      const index = this.notificationHandlers.indexOf(handler);
      if (index >= 0) this.notificationHandlers.splice(index, 1);
    };
  }

  private failAll(reason: string): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    this.pending.clear();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.failAll("the language server was stopped");
    try {
      this.child.kill();
    } catch {
      // Already gone.
    }
  }
}
