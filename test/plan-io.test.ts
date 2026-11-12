import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reviewPlan, writePlan, plansDir, type PlanIo } from "../src/plan-io";
import { getExecutionMode, initExecutionMode, setExecutionModePersistence } from "../src/execution-modes";
import { PLAN_APPROVAL_OPTIONS, type PlanDocument } from "../src/plan-mode";

const doc: PlanDocument = {
  title: "Plan A",
  body: "1. do the thing",
  files: ["src/a.ts"],
  createdAt: new Date("2026-01-02T03:04:05.000Z"),
};

beforeEach(() => {
  setExecutionModePersistence(undefined);
  initExecutionMode(false, "plan");
});

/** Recording fake for the UI callbacks. */
function deps(choice: string | undefined, confirm = true) {
  const notes: Array<{ msg: string; type?: string }> = [];
  return {
    notes,
    select: async () => choice,
    confirm: async () => confirm,
    notify: (msg: string, type?: "info" | "warning" | "error") => notes.push({ msg, type }),
  };
}

describe("plan-io: writePlan", () => {
  test("writes the plan under .qronos/plans and returns a relative path", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "qronos-plan-"));
    const written = await writePlan(cwd, doc);
    expect(written.relativePath).toStartWith(".qronos/plans/");
    expect(existsSync(written.absolutePath)).toBe(true);
    expect(readFileSync(written.absolutePath, "utf8")).toContain("# Plan A");
  });

  test("creates the plans directory on first use", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "qronos-plan-"));
    expect(existsSync(plansDir(cwd))).toBe(false);
    await writePlan(cwd, doc);
    expect(existsSync(plansDir(cwd))).toBe(true);
  });

  test("uses injected io so tests need no real filesystem", async () => {
    const written: Array<{ path: string; contents: string }> = [];
    const io: PlanIo = {
      mkdir: async () => {},
      writeFile: async (path, contents) => {
        written.push({ path, contents });
      },
      now: () => new Date("2026-01-02T03:04:05.000Z"),
    };
    const result = await writePlan("/proj", doc, io);
    expect(result.relativePath).toBe(".qronos/plans/2026-01-02T03-04-05-000Z.md");
    expect(written).toHaveLength(1);
    expect(written[0]!.contents).toContain("Plan A");
  });
});

describe("plan-io: reviewPlan", () => {
  test("approving leaves plan mode and enables automatic edits", async () => {
    const d = deps(PLAN_APPROVAL_OPTIONS[0]);
    const res = await reviewPlan(d, doc, ".qronos/plans/x.md");
    expect(res.decision).toBe("approve");
    expect(getExecutionMode()).toBe("edit-automatically");
    expect(d.notes[0]!.msg).toContain("approved");
  });

  test("keeping-editing stays in plan mode", async () => {
    const d = deps(PLAN_APPROVAL_OPTIONS[1]);
    const res = await reviewPlan(d, doc, "p.md");
    expect(res.decision).toBe("keep-editing");
    expect(getExecutionMode()).toBe("plan");
  });

  test("rejecting stays in plan mode", async () => {
    const d = deps(PLAN_APPROVAL_OPTIONS[2]);
    const res = await reviewPlan(d, doc, "p.md");
    expect(res.decision).toBe("reject");
    expect(getExecutionMode()).toBe("plan");
  });

  test("a cancelled selector never approves and never leaves plan mode", async () => {
    const d = deps(undefined);
    const res = await reviewPlan(d, doc, "p.md");
    expect(res.decision).toBe("keep-editing");
    expect(getExecutionMode()).toBe("plan");
  });

  test("approving is the only path that leaves plan mode", async () => {
    for (const choice of [PLAN_APPROVAL_OPTIONS[1], PLAN_APPROVAL_OPTIONS[2], undefined]) {
      initExecutionMode(false, "plan");
      await reviewPlan(deps(choice), doc, "p.md");
      expect(getExecutionMode()).toBe("plan");
    }
  });
});
