import { describe, expect, test } from "bun:test";
import {
  PLAN_APPROVAL_OPTIONS,
  planApprovalPrompt,
  planDecisionFromChoice,
  planFileName,
  planRelativePath,
  planSummaryLine,
  renderPlanDocument,
  type PlanDocument,
} from "../src/plan-mode";

const doc: PlanDocument = {
  title: "Add rate limiting to the API",
  body: "1. Read the router\n2. Add a limiter middleware\n3. Add tests",
  files: ["src/api.ts", "test/api.test.ts"],
  createdAt: new Date("2026-01-02T03:04:05.000Z"),
};

describe("plan-mode: paths", () => {
  test("file names are filesystem-safe and sort chronologically", () => {
    const a = planFileName(new Date("2026-01-02T03:04:05.678Z"));
    const b = planFileName(new Date("2026-01-02T03:04:06.000Z"));
    expect(a).toBe("2026-01-02T03-04-05-678Z.md");
    expect(a).not.toContain(":");
    expect(b > a).toBe(true);
  });

  test("plans live under .qronos/plans", () => {
    expect(planRelativePath("x.md")).toBe(".qronos/plans/x.md");
  });
});

describe("plan-mode: rendering", () => {
  test("includes the title, body and the files the plan will touch", () => {
    const md = renderPlanDocument(doc);
    expect(md).toContain("# Add rate limiting to the API");
    expect(md).toContain("2. Add a limiter middleware");
    expect(md).toContain("`src/api.ts`");
    expect(md).toContain("2026-01-02T03:04:05.000Z");
  });

  test("omits the files section entirely when the plan names no files", () => {
    const md = renderPlanDocument({ ...doc, files: [] });
    expect(md).not.toContain("Files expected to change");
  });

  test("states plainly that nothing has been applied yet", () => {
    expect(renderPlanDocument(doc)).toContain("Nothing here has been applied yet");
  });
});

describe("plan-mode: decisions", () => {
  test("approve maps to approve", () => {
    expect(planDecisionFromChoice(PLAN_APPROVAL_OPTIONS[0])).toBe("approve");
  });

  test("reject maps to reject", () => {
    expect(planDecisionFromChoice(PLAN_APPROVAL_OPTIONS[2])).toBe("reject");
  });

  test("keep-editing maps to keep-editing", () => {
    expect(planDecisionFromChoice(PLAN_APPROVAL_OPTIONS[1])).toBe("keep-editing");
  });

  test("a cancelled or unknown choice keeps plan mode on, never approves", () => {
    for (const choice of [undefined, "", "something else"]) {
      expect(planDecisionFromChoice(choice)).toBe("keep-editing");
    }
  });

  test("matching is case-insensitive so UI copy changes cannot invert the decision", () => {
    expect(planDecisionFromChoice("APPROVE plan")).toBe("approve");
    expect(planDecisionFromChoice("Approve")).toBe("approve");
  });
});

describe("plan-mode: approval prompt", () => {
  test("says how many files the plan expects to change", () => {
    const { title, message } = planApprovalPrompt(doc, ".qronos/plans/x.md", 80);
    expect(title).toBe("Plan ready for review");
    expect(message).toContain("It expects to change 2 files");
    expect(message).toContain(".qronos/plans/x.md");
  });

  test("says so when the plan names no files", () => {
    const { message } = planApprovalPrompt({ ...doc, files: [] }, "p.md", 80);
    expect(message).toContain("does not list any files");
  });

  test("singular wording for one file", () => {
    const { message } = planApprovalPrompt({ ...doc, files: ["a.ts"] }, "p.md", 80);
    expect(message).toContain("change 1 file.");
  });
});

describe("plan-mode: summary line", () => {
  test("is one bounded line, truncated with an ellipsis when too wide", () => {
    const line = planSummaryLine(doc, ".qronos/plans/2026-01-02T03-04-05-678Z.md", 20);
    expect(line.length).toBeLessThanOrEqual(20);
    expect(line.endsWith("…")).toBe(true);
    expect(line).not.toContain("\n");
  });

  test("is not truncated when it fits", () => {
    const line = planSummaryLine(doc, "p.md", 120);
    expect(line).toBe("Plan saved: p.md");
  });
});
