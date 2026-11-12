// Plan mode's artifact. In plan mode the agent explores and then writes a plan
// to disk instead of editing code; leaving plan mode presents that plan for
// approval. This module is pure — no fs, no UI — so the rendering and the
// approve/reject rules are testable without a terminal.
//
// Why a file and not only session state: the plan is the thing the user reviews
// before any write happens, and they should be able to open it in their editor
// and read it later. It is also the only part of plan mode that survives
// /compact, which is why the path is echoed into the transcript too.

export const PLAN_DIR_NAME = ".qronos";
export const PLAN_SUBDIR = "plans";

/** Files are named by timestamp so a session's plans sort chronologically. */
export function planFileName(now: Date = new Date()): string {
  const iso = now.toISOString().replace(/[:.]/g, "-");
  return `${iso}.md`;
}

/** Where a plan file lives, relative to the project root. */
export function planRelativePath(fileName: string): string {
  return `${PLAN_DIR_NAME}/${PLAN_SUBDIR}/${fileName}`;
}

export interface PlanDocument {
  /** One-line summary shown in the approval dialog. */
  title: string;
  /** Markdown body: the ordered steps the agent intends to take. */
  body: string;
  /** Files the plan expects to touch, used to warn before approval. */
  files?: readonly string[];
  createdAt?: Date;
}

/** Render the markdown that gets written to `.qronos/plans/<ts>.md`. */
export function renderPlanDocument(doc: PlanDocument): string {
  const created = (doc.createdAt ?? new Date()).toISOString();
  const lines = [
    `# ${doc.title}`,
    "",
    `_Created ${created} by Qronos CLI in plan mode. Nothing here has been applied yet._`,
    "",
    doc.body.trim(),
  ];
  if (doc.files && doc.files.length > 0) {
    lines.push("", "## Files expected to change", "");
    for (const f of doc.files) lines.push(`- \`${f}\``);
  }
  lines.push("", "---", "", "Approve this plan to leave plan mode and allow edits.");
  return `${lines.join("\n")}\n`;
}

export type PlanDecision = "approve" | "keep-editing" | "reject";

/**
 * Map a selector choice onto a decision. Index-based so the UI copy can change
 * without breaking behaviour; an unknown/cancelled choice keeps plan mode on
 * rather than silently approving writes.
 */
export function planDecisionFromChoice(choice: string | undefined): PlanDecision {
  const c = (choice ?? "").trim().toLowerCase();
  if (c.startsWith("approve")) return "approve";
  if (c.startsWith("reject")) return "reject";
  return "keep-editing";
}

export const PLAN_APPROVAL_OPTIONS = [
  "Approve plan — leave plan mode and apply changes",
  "Keep editing the plan — stay in plan mode",
  "Reject — discard this plan",
] as const;

/** Dialog title/message shown when leaving plan mode with a plan on disk. */
export function planApprovalPrompt(doc: PlanDocument, path: string, width: number): { title: string; message: string } {
  const files = doc.files && doc.files.length > 0 ? doc.files.length : 0;
  const fileNote =
    files === 0
      ? "It does not list any files yet."
      : `It expects to change ${files} file${files === 1 ? "" : "s"}.`;
  return {
    title: "Plan ready for review",
    message: [
      doc.title,
      "",
      fileNote,
      `Saved to ${path}.`,
      "",
      "Approve to leave plan mode. Approving only changes the mode — the agent still edits from here, so you can review each change.",
    ].join("\n"),
  };
}

/**
 * A short transcript line. Kept one-line and bounded so a plan never floods the
 * conversation the way the raw markdown would.
 */
export function planSummaryLine(doc: PlanDocument, path: string, width: number): string {
  const max = Math.max(20, width);
  const heading = `Plan saved: ${path}`;
  return heading.length > max ? `${heading.slice(0, max - 1)}…` : heading;
}
