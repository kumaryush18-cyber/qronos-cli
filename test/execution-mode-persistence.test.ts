// 0.5.0 — executionMode persistence helpers added alongside readAutoUpdate.
// Kept in its own file so the original readAutoUpdate suite above is untouched.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAutoUpdate, readConfigObject, writeConfigPatch } from "../src/cli-config";

function tempConfig(): string {
  return join(mkdtempSync(join(tmpdir(), "qronos-cfg-")), "config.json");
}

describe("cli-config: executionMode persistence", () => {
  test("creates the file when it does not exist yet", () => {
    const path = tempConfig();
    expect(writeConfigPatch(path, { executionMode: "plan" })).toBe(true);
    expect(readConfigObject(path)?.executionMode).toBe("plan");
  });

  test("preserves unrelated keys such as autoUpdate", () => {
    const path = tempConfig();
    writeFileSync(path, JSON.stringify({ autoUpdate: false, other: "keep" }));
    expect(writeConfigPatch(path, { executionMode: "manual" })).toBe(true);
    const parsed = readConfigObject(path);
    expect(parsed?.executionMode).toBe("manual");
    expect(parsed?.autoUpdate).toBe(false);
    expect(parsed?.other).toBe("keep");
    // The opt-out must survive a mode write.
    expect(readAutoUpdate(path)).toBe(false);
  });

  test("refuses to clobber a corrupt config instead of silently deleting it", () => {
    const path = tempConfig();
    writeFileSync(path, "{ not json");
    expect(writeConfigPatch(path, { executionMode: "plan" })).toBe(false);
    expect(readFileSync(path, "utf8")).toBe("{ not json");
    expect(readConfigObject(path)).toBeUndefined();
  });

  test("rejects a non-object JSON config", () => {
    const path = tempConfig();
    writeFileSync(path, "[1,2,3]");
    expect(writeConfigPatch(path, { executionMode: "plan" })).toBe(false);
    expect(readConfigObject(path)).toBeUndefined();
  });

  test("missing file reads as undefined without throwing", () => {
    expect(readConfigObject(tempConfig())).toBeUndefined();
    expect(readAutoUpdate(tempConfig())).toBe(true);
  });
});
