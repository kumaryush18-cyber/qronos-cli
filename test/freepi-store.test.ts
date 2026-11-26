// The token file: it must survive a broken file, keep mode 600, and never show
// a secret in a message.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addFreepiToken,
  parseFreepiStore,
  persistPoolRecords,
  readFreepiStore,
  removeFreepiToken,
  writeFreepiStore,
} from "../src/freepi-store";

const made: string[] = [];

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "qronos-freepi-"));
  made.push(dir);
  return join(dir, "freepi.json");
}

afterEach(() => {
  while (made.length > 0) {
    const dir = made.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("parseFreepiStore", () => {
  test("a broken file reads as empty, never as a crash", () => {
    expect(parseFreepiStore("{not json")).toEqual({ version: 1, tokens: [] });
    expect(parseFreepiStore("")).toEqual({ version: 1, tokens: [] });
    expect(parseFreepiStore("[]")).toEqual({ version: 1, tokens: [] });
  });

  test("an entry without a token is dropped", () => {
    const store = parseFreepiStore(JSON.stringify({ tokens: [{ id: "t1" }, { id: "t2", token: "keep" }] }));
    expect(store.tokens.length).toBe(1);
    expect(store.tokens[0]!.token).toBe("keep");
  });

  test("a token saved by an older build gets a session id", () => {
    const store = parseFreepiStore(JSON.stringify({ tokens: [{ id: "t1", token: "abc" }] }));
    expect(store.tokens[0]!.sessionId.length).toBeGreaterThan(10);
  });

  test("an existing session id is kept, not replaced", () => {
    const store = parseFreepiStore(JSON.stringify({ tokens: [{ id: "t1", token: "abc", sessionId: "s-1" }] }));
    expect(store.tokens[0]!.sessionId).toBe("s-1");
  });
});

describe("read and write", () => {
  test("a missing file is an empty store", async () => {
    expect(await readFreepiStore(join(tmpdir(), "no-such-folder", "freepi.json"))).toEqual({ version: 1, tokens: [] });
  });

  test("what is written is what is read back", async () => {
    const path = tempFile();
    await writeFreepiStore(path, {
      version: 1,
      tokens: [{ id: "t1", token: "abc", sessionId: "s-1", label: "main", coolDownUntil: 0, failures: 0 }],
    });
    const store = await readFreepiStore(path);
    expect(store.tokens[0]!.label).toBe("main");
  });

  test("the file is private: mode 600", async () => {
    if (process.platform === "win32") return;
    const path = tempFile();
    await writeFreepiStore(path, { version: 1, tokens: [] });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("a loosened file is tightened on the next write", async () => {
    if (process.platform === "win32") return;
    const path = tempFile();
    writeFileSync(path, "{}", { mode: 0o644 });
    chmodSync(path, 0o644);
    await writeFreepiStore(path, { version: 1, tokens: [] });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("a newline ends the file, so an editor and git both behave", async () => {
    const path = tempFile();
    await writeFreepiStore(path, { version: 1, tokens: [] });
    expect(readFileSync(path, "utf8").endsWith("\n")).toBe(true);
  });
});

describe("addFreepiToken", () => {
  test("adds the first token as t1", async () => {
    const path = tempFile();
    const result = await addFreepiToken(path, "fp_first_token");
    expect(result.duplicate).toBe(false);
    expect(result.record.id).toBe("t1");
    expect(existsSync(path)).toBe(true);
  });

  test("trims the token before saving", async () => {
    const path = tempFile();
    const result = await addFreepiToken(path, "  fp_padded_token  ");
    expect(result.record.token).toBe("fp_padded_token");
  });

  test("the same token twice is not saved twice", async () => {
    const path = tempFile();
    await addFreepiToken(path, "fp_same");
    const second = await addFreepiToken(path, "fp_same");
    expect(second.duplicate).toBe(true);
    const store = await readFreepiStore(path);
    expect(store.tokens.length).toBe(1);
  });

  test("a different token gets the next id", async () => {
    const path = tempFile();
    await addFreepiToken(path, "fp_one");
    const second = await addFreepiToken(path, "fp_two", "spare");
    expect(second.record.id).toBe("t2");
    expect(second.record.label).toBe("spare");
  });
});

describe("removeFreepiToken", () => {
  test("removes by id", async () => {
    const path = tempFile();
    await addFreepiToken(path, "fp_one");
    const result = await removeFreepiToken(path, "t1");
    expect(result.removed?.token).toBe("fp_one");
    expect(result.remaining).toBe(0);
  });

  test("removes by label, in any case", async () => {
    const path = tempFile();
    await addFreepiToken(path, "fp_one", "Main");
    const result = await removeFreepiToken(path, "main");
    expect(result.removed?.id).toBe("t1");
  });

  test("an unknown word removes nothing and lists what exists", async () => {
    const path = tempFile();
    await addFreepiToken(path, "fp_one", "main");
    const result = await removeFreepiToken(path, "nope");
    expect(result.removed).toBeUndefined();
    expect(result.known).toEqual(["main"]);
    expect(result.remaining).toBe(1);
  });
});

describe("persistPoolRecords", () => {
  test("cool-down state is written back and the tokens are untouched", async () => {
    const path = tempFile();
    await addFreepiToken(path, "fp_one");
    const store = await readFreepiStore(path);
    await persistPoolRecords(path, store.tokens.map((record) => ({ ...record, coolDownUntil: 5_000, failures: 1 })));
    const after = await readFreepiStore(path);
    expect(after.tokens[0]!.coolDownUntil).toBe(5_000);
    expect(after.tokens[0]!.token).toBe("fp_one");
  });

  test("a token removed meanwhile is not brought back by a stale write", async () => {
    const path = tempFile();
    await addFreepiToken(path, "fp_one");
    const stale = await readFreepiStore(path);
    await removeFreepiToken(path, "t1");
    await persistPoolRecords(path, stale.tokens.map((record) => ({ ...record, coolDownUntil: 1 })));
    expect((await readFreepiStore(path)).tokens.length).toBe(0);
  });
});
