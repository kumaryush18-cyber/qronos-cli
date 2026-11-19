import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findPiRoot, patchQuitLabel } from "../scripts/patch-pi-quit.mjs";

describe("/quit label patch", () => {
  const template = "    { name: \"quit\", description: `Quit ${APP_NAME}` },";

  test("turns 'Quit ${APP_NAME}' into a plain 'Quit'", () => {
    expect(patchQuitLabel(template)).toBe('    { name: "quit", description: "Quit" },');
  });

  test("works on the minified bundle text too", () => {
    expect(patchQuitLabel('{name:"quit",description:`Quit ${APP_NAME}`}')).toBe(
      '{name:"quit",description: "Quit"}',
    );
  });

  test("is idempotent: running it twice changes nothing", () => {
    const once = patchQuitLabel(template);
    expect(patchQuitLabel(once)).toBe(once);
  });

  test("leaves unrelated text alone", () => {
    const other = 'description: `Quit something else`';
    expect(patchQuitLabel(other)).toBe(other);
  });
});

describe("findPiRoot", () => {
  test("walks up to node_modules/@earendil-works/pi-coding-agent", () => {
    const root = join(tmpdir(), `qronos-patch-${Math.random().toString(36).slice(2)}`);
    const pi = join(root, "node_modules", "@earendil-works", "pi-coding-agent");
    mkdirSync(pi, { recursive: true });
    writeFileSync(join(pi, "package.json"), "{}");
    const deep = join(root, "scripts");
    mkdirSync(deep, { recursive: true });
    expect(findPiRoot(deep)).toBe(pi);
  });
});
