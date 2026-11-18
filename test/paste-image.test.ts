// /paste-image writes to screenshots/, never to images/ (that folder belongs
// to generate_image). The path helper is pure, so it can be checked without a
// real clipboard.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { SCREENSHOTS_DIR, screenshotPaths } from "../src/commands";

describe("screenshotPaths", () => {
  test("uses the screenshots folder, not images", () => {
    const { targetPath, relPath } = screenshotPaths("/tmp/proj", 1700000000000);
    expect(SCREENSHOTS_DIR).toBe("screenshots");
    expect(relPath).toBe("screenshots/screenshot_1700000000000.png");
    expect(targetPath).toBe(join("/tmp/proj", "screenshots/screenshot_1700000000000.png"));
  });

  test("two screenshots in the same second do not collide", () => {
    const a = screenshotPaths("/tmp/proj", 1);
    const b = screenshotPaths("/tmp/proj", 2);
    expect(a.targetPath).not.toBe(b.targetPath);
  });
});
