// fs/UI half of plan mode. Split from plan-mode.ts so the rendering and
// decision rules stay pure and testable; everything here is injected-able so
// tests drive it without a real terminal or filesystem.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  PLAN_DIR_NAME,
  PLAN_SUBDIR,
  PLAN_APPROVAL_OPTIONS,
  planApprovalPrompt,
  planDecisionFromChoice,
  planFileName,
  planRelativePath,
  renderPlanDocument,
  type PlanDecision,
  type PlanDocument,
} from "./plan-mode";
import { getExecutionMode, setExecutionMode } from "./execution-modes";

export interface PlanIo {
  mkdir(path: string): Promise<void>;
  writeFile(path: string, contents: string): Promise<void>;
  now(): Date;
}

const realIo: PlanIo = {
  mkdir: async (path) => {
    await mkdir(path, { recursive: true });
  },
  writeFile: async (path, contents) => {
    await writeFile(path, contents, "utf8");
  },
  now: () => new Date(),
};

/** Absolute path of the plans directory for a project root. */
export function plansDir(cwd: string): string {
  return join(cwd, PLAN_DIR_NAME, PLAN_SUBDIR);
}

/**
 * Write a plan to `.qronos/plans/<timestamp>.md`.
 * Returns the project-relative path so it can be shown and opened.
 */
export async function writePlan(
  cwd: string,
  doc: PlanDocument,
  io: PlanIo = realIo,
): Promise<{ relativePath: string; absolutePath: string }> {
  const fileName = planFileName(io.now());
  const relativePath = planRelativePath(fileName);
  const absolutePath = join(cwd, relativePath);
  await io.mkdir(plansDir(cwd));
  await io.writeFile(absolutePath, renderPlanDocument(doc));
  return { relativePath, absolutePath };
}

export interface PlanApprovalDeps {
  select(title: string, options: string[]): Promise<string | undefined>;
  confirm(title: string, message: string): Promise<boolean>;
  notify(message: string, type?: "info" | "warning" | "error"): void;
}

/**
 * Present a written plan and apply the user's decision.
 *
 * Approving switches the execution mode to "edit-automatically" — the same
 * handoff Claude Code makes when it leaves plan mode — so the mode gate in
 * tool-guard immediately starts allowing writes. Rejecting discards the plan
 * and leaves the mode untouched. Cancelling anything keeps plan mode on, which
 * is the safe default: an unclear answer must never enable writes.
 */
export async function reviewPlan(
  deps: PlanApprovalDeps,
  doc: PlanDocument,
  relativePath: string,
  width = 80,
): Promise<{ decision: PlanDecision; mode: string }> {
  const { title, message } = planApprovalPrompt(doc, relativePath, width);
  const choice = await deps.select(title, [...PLAN_APPROVAL_OPTIONS]);
  const decision = planDecisionFromChoice(choice);

  if (decision === "approve") {
    setExecutionMode("edit-automatically");
    deps.notify(`Plan approved. Edits are now applied automatically. Saved at ${relativePath}.`, "info");
  } else if (decision === "reject") {
    // Rejecting is deliberate, so ask rather than assume. A cancel here keeps
    // plan mode on.
    const sure = await deps.confirm("Discard plan?", `Delete the plan at ${relativePath} from this session?`);
    if (sure) {
      deps.notify("Plan discarded. Still in plan mode.", "info");
    } else {
      deps.notify("Plan kept. Still in plan mode.", "info");
    }
  } else {
    deps.notify(`Still in plan mode. The plan is at ${relativePath}.`, "info");
  }

  return { decision, mode: getExecutionMode() };
}
