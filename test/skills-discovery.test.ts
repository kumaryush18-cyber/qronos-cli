import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SKILLS_DIR } from "../src/pi-launch";

describe("bundled skills discovery", () => {
  test("SKILLS_DIR exists and contains bundled skills", () => {
    expect(existsSync(SKILLS_DIR)).toBe(true);
    const entries = readdirSync(SKILLS_DIR, { withFileTypes: true });
    const skillDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);

    // Core bundled skills from developer-skill-pack + long-jobs
    expect(skillDirs).toContain("long-jobs");
    expect(skillDirs).toContain("debug");
    expect(skillDirs).toContain("regression-guard");
    expect(skillDirs).toContain("research-spike");
    expect(skillDirs).toContain("deploy-check");
    expect(skillDirs).toContain("setup-repo");
  });

  test("every bundled skill has a valid SKILL.md with name and description", () => {
    const entries = readdirSync(SKILLS_DIR, { withFileTypes: true });
    const skillDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);

    for (const dir of skillDirs) {
      const skillFile = join(SKILLS_DIR, dir, "SKILL.md");
      expect(existsSync(skillFile)).toBe(true);
      const content = readFileSync(skillFile, "utf8").replace(/\r\n/g, "\n");
      const match = content.match(/^---\n([\s\S]*?)\n---/);
      expect(match).not.toBeNull();
      const fm = match![1]!;
      expect(fm).toMatch(new RegExp(`^name:\\s*${dir}$`, "m"));
      expect(fm).toMatch(/^description:\s*.+$/m);
    }
  });
});
