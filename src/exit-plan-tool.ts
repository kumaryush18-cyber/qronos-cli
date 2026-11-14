// Registers the `exit_plan_mode` tool the agent calls at the end of plan mode.
//
// Mirrors Claude Code's ExitPlanMode: the agent writes its plan, the tool is
// called (not typed by the user), and the plan is presented for approval. The
// tool is the only path out of plan mode that switches the mode, so a plan can
// never be approved implicitly by a stray Shift+Tab — the user has to choose.
import type { ExtensionAPI, ExtensionToolContext, InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getExecutionMode, setExecutionMode } from "./execution-modes";
import { reviewPlan, writePlan, type PlanIo } from "./plan-io";
import { planSummaryLine, type PlanDocument } from "./plan-mode";

export const EXIT_PLAN_TOOL_NAME = "exit_plan_mode";
export const ENTER_PLAN_TOOL_NAME = "enter_plan_mode";

const ENTER_PARAMS = Type.Object({
  reason: Type.String({ description: "Why plan mode is needed (e.g. multi-file changes, architectural refactoring, complex bug fix)" }),
});

const ENTER_DESCRIPTION =
  "Enter plan mode to explore the codebase and design an implementation plan before writing or modifying any code. In plan mode, edits and destructive actions are paused. Once finished exploring, call exit_plan_mode for user approval.";

const PARAMS = Type.Object({
  title: Type.String({ description: "One-line title of the plan" }),
  plan: Type.String({ description: "The ordered plan in markdown: what you will change and why" }),
  files: Type.Optional(
    Type.Array(Type.String(), { description: "Files the plan expects to change (repository-relative)" }),
  ),
});

const DESCRIPTION =
  "Present your plan and ask the user to approve it before you start editing. Call this once you have finished exploring in plan mode. It writes the plan to .qronos/plans/ and asks the user to approve, edit, or reject it. Only available in plan mode.";

export interface CreateExitPlanToolOptions {
  /** Project root the plan file is written under. When absent, the tool's own
   * context cwd is used, which is what the interactive session reports. */
  cwd?: string;
  /** Injected in tests. */
  io?: PlanIo;
}

export function createExitPlanToolExtension(opts: CreateExitPlanToolOptions): InlineExtension {
  return {
    name: "qronos-exit-plan",
    factory(qronos: ExtensionAPI) {
      qronos.registerTool({
        name: ENTER_PLAN_TOOL_NAME,
        label: "Enter Plan Mode",
        description: ENTER_DESCRIPTION,
        promptSnippet:
          "Call enter_plan_mode to explore and design a plan before modifying code on complex tasks",
        parameters: ENTER_PARAMS,
        async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<any> {
          if (getExecutionMode() === "plan") {
            return {
              content: [
                {
                  type: "text" as const,
                  text: "Already in plan mode. Explore the codebase using read tools and call exit_plan_mode when your plan is ready.",
                },
              ],
              details: { ok: true, mode: "plan" },
            };
          }
          setExecutionMode("plan");
          const ui = ctx.ui as { notify?: (msg: string, type?: string) => void } | undefined;
          ui?.notify?.(`Entered Plan Mode: ${params.reason}`, "info");
          return {
            content: [
              {
                type: "text" as const,
                text: `Switched to Plan Mode (${params.reason}). Edits are now paused. Use read, grep, and find tools to explore the codebase, design your plan, and call exit_plan_mode when ready for human approval.`,
              },
            ],
            details: { ok: true, mode: "plan", reason: params.reason },
          };
        },
      });

      qronos.registerTool({
        name: EXIT_PLAN_TOOL_NAME,
        label: "Exit Plan Mode",
        description: DESCRIPTION,
        promptSnippet:
          "In plan mode, finish by calling exit_plan_mode with your plan so the user can approve it before any edits",
        parameters: PARAMS,
        // The tool always activates, but its call is refused outside plan mode
        // (see the execute body) so the model cannot use it to skip review.
        async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<any> {
          if (getExecutionMode() !== "plan") {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `exit_plan_mode is only available in plan mode (current mode: ${getExecutionMode()}). Edit and run directly instead.`,
                },
              ],
              details: { ok: false, reason: "not-in-plan-mode" },
            };
          }

          const doc: PlanDocument = {
            title: params.title,
            body: params.plan,
            files: params.files,
            createdAt: opts.io?.now() ?? new Date(),
          };

          const cwd = opts.cwd ?? ctx.cwd;
          const written = await writePlan(cwd, doc, opts.io);
          const width = 80;
          const { decision, mode } = await reviewPlan(toolUi(ctx), doc, written.relativePath, width);

          const text =
            decision === "approve"
              ? `Plan approved. Execution mode is now "${mode}". You may start editing.\n\nThe plan:\n\n${params.plan}`
              : decision === "reject"
                ? `The user rejected this plan. Do not act on it. Stay in plan mode and propose a different approach.`
                : `The user is still reviewing the plan. Do not edit anything yet; wait for approval.`;

          qronos.appendEntry(PLAN_ENTRY_TYPE, {
            path: written.relativePath,
            title: doc.title,
            decision,
          });

          return {
            content: [{ type: "text" as const, text: `${text}\n\n${planSummaryLine(doc, written.relativePath, width)}` }],
            details: { ok: decision === "approve", path: written.relativePath, decision, mode },
          };
        },
      });
    },
  };
}

/** Custom session entry so a plan approval survives resume and /compact. */
export const PLAN_ENTRY_TYPE = "qronos-plan";

/** Adapt pi's tool context onto the plan review UI. */
function toolUi(ctx: ExtensionToolContext) {
  const ui = ctx.ui as
    | {
        select?: (title: string, options: string[]) => Promise<string | undefined>;
        confirm?: (title: string, message: string) => Promise<boolean>;
        notify?: (message: string, type?: "info" | "warning" | "error") => void;
      }
    | undefined;
  return {
    // Rejecting a plan is the safe default when there is no interactive UI
    // (RPC/print mode): never auto-approve writes without a human.
    select: ui?.select ?? (async () => undefined),
    confirm: ui?.confirm ?? (async () => false),
    notify: ui?.notify ?? (() => {}),
  };
}
