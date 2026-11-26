// Where the free-pi tokens live, and how they are read and written.
//
// One file: `~/.qronos/agent/freepi.json`, mode 600, next to the sign-in
// token. It is ours; pi's own `~/.free-pi` folder is never touched.
//
// The shape is small on purpose:
//
//   { "version": 1, "tokens": [
//       { "id": "t1", "token": "…", "label": "main",
//         "sessionId": "…", "addedAt": "…", "coolDownUntil": 0, "failures": 0 } ] }
//
// A token is a secret, so nothing here ever writes it to a log or prints it.
// Reading is forgiving: a broken file reads as empty rather than throwing,
// because a bad file must never stop the CLI from starting.
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { makeTokenRecord, type FreepiTokenRecord } from "./freepi-tokens";

export interface FreepiStore {
  version: 1;
  tokens: FreepiTokenRecord[];
}

export const EMPTY_STORE: FreepiStore = { version: 1, tokens: [] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Read the file's text into a store, tolerating anything.
 *
 * A token without a session id gets one here, so a file written by an older
 * build keeps working without a migration step.
 */
export function parseFreepiStore(text: string): FreepiStore {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { version: 1, tokens: [] };
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.tokens)) return { version: 1, tokens: [] };
  const tokens: FreepiTokenRecord[] = [];
  for (const raw of parsed.tokens) {
    if (!isRecord(raw)) continue;
    if (typeof raw.token !== "string" || raw.token.trim() === "") continue;
    const id = typeof raw.id === "string" && raw.id !== "" ? raw.id : `t${tokens.length + 1}`;
    tokens.push({
      id,
      token: raw.token,
      ...(typeof raw.label === "string" && raw.label !== "" ? { label: raw.label } : {}),
      sessionId: typeof raw.sessionId === "string" && raw.sessionId !== "" ? raw.sessionId : randomUUID(),
      ...(typeof raw.addedAt === "string" ? { addedAt: raw.addedAt } : {}),
      coolDownUntil: typeof raw.coolDownUntil === "number" ? raw.coolDownUntil : 0,
      failures: typeof raw.failures === "number" ? raw.failures : 0,
    });
  }
  return { version: 1, tokens };
}

/** The store on disk, or an empty one when the file is missing or broken. */
export async function readFreepiStore(path: string): Promise<FreepiStore> {
  try {
    const text = await readFile(path, "utf8");
    return parseFreepiStore(text);
  } catch {
    return { version: 1, tokens: [] };
  }
}

/** Write the store, always mode 600, so the file is private even after an edit. */
export async function writeFreepiStore(path: string, store: FreepiStore): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ version: 1, tokens: store.tokens }, null, 2)}\n`, { mode: 0o600 });
  try {
    await chmod(path, 0o600);
  } catch {
    // Windows has no POSIX mode; the file is still in the user's own folder.
  }
}

export interface AddTokenResult {
  record: FreepiTokenRecord;
  /** True when this exact token was already saved. */
  duplicate: boolean;
}

/**
 * Add a token.
 *
 * A duplicate is not a second copy: saving the same key twice would make the
 * pool use one key in two "slots", which is the concurrency bug in disguise.
 */
export async function addFreepiToken(
  path: string,
  token: string,
  label?: string,
): Promise<AddTokenResult> {
  const trimmed = token.trim();
  const store = await readFreepiStore(path);
  const existing = store.tokens.find((record) => record.token === trimmed);
  if (existing) return { record: existing, duplicate: true };
  const record = makeTokenRecord(trimmed, store.tokens, label);
  store.tokens.push(record);
  await writeFreepiStore(path, store);
  return { record, duplicate: false };
}

export interface RemoveTokenResult {
  removed?: FreepiTokenRecord;
  remaining: number;
  /** Every token, by id and label, when a word matched none of them. */
  known: string[];
}

/** Remove by id (`t1`) or by label (`main`). An unknown word removes nothing. */
export async function removeFreepiToken(path: string, word: string): Promise<RemoveTokenResult> {
  const store = await readFreepiStore(path);
  const wanted = word.trim().toLowerCase();
  const index = store.tokens.findIndex(
    (record) =>
      record.id.toLowerCase() === wanted || (record.label ?? "").toLowerCase() === wanted,
  );
  const known = store.tokens.map((record) => record.label ?? record.id);
  if (index === -1) return { remaining: store.tokens.length, known };
  const [removed] = store.tokens.splice(index, 1);
  await writeFreepiStore(path, store);
  return { removed, remaining: store.tokens.length, known };
}

/** Save cool-down state from a pool run, without touching the tokens. */
export async function persistPoolRecords(
  path: string,
  records: readonly FreepiTokenRecord[],
): Promise<void> {
  const store = await readFreepiStore(path);
  const byId = new Map(records.map((record) => [record.id, record]));
  const tokens = store.tokens.map((record) => {
    const next = byId.get(record.id);
    if (!next) return record;
    return { ...record, coolDownUntil: next.coolDownUntil ?? 0, failures: next.failures ?? 0 };
  });
  await writeFreepiStore(path, { version: 1, tokens });
}
