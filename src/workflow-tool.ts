// The `workflow` tool: one script in, one small report out.
//
// This is the tool side of the ultracode feature. It owns the boring parts the
// runtime must not know about: turning a script request into real subagents,
// formatting the report for the chat, and keeping the last run around so
// `/workflows` can show it.
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionToolContext,
  InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { AgentRegistry } from "./agent-registry";
import { BUILTIN_AGENTS } from "./agent-discovery";
import type { AgentDefinition } from "./agent-discovery";
import { defaultSubagentRunner, type SubagentRunner } from "./agent-tool";
import { WorkflowRuntime } from "./workflow-runtime";
import {
  RUNNING,
  cross,
  formatDuration,
  formatTokens,
  pad,
  phaseMark,
  replayMark,
  stoppedMark,
  tick,
  tokenBar,
} from "./workflow-glyphs";
import { WorkflowJobManager, type WorkflowJob } from "./workflow-jobs";
import { journalDir, journalPath, pruneJournals } from "./workflow-journal";
import { openWorkflowPanel } from "./workflow-panel";
import { saveWorkflowScript } from "./workflow-save";
import { listSavedScripts, readSavedScript, resolveSavedScript, savedScriptLine, scriptDirFor, scriptProblem, shortPath } from "./workflow-library";
import { askConfirm } from "./workflow-confirm";
import { withToolExecutor } from "./context-proxy";
import {
  failedAgents,
  retryFailed,
  retryFailedLines,
  retryFailedNotice,
  retryFailedTitle,
  retryRefusal,
  type RetryOutcome,
} from "./workflow-retry-failed";
import {
  agentsOfPhase,
  phaseRerunLines,
  phaseRerunNotice,
  phaseRerunRefusal,
  phaseRerunTitle,
  rerunPhase,
  type PhaseRerunOutcome,
} from "./workflow-phase-rerun";
import { editTextInEditor } from "./editor-edit";
import { writeFileSync } from "node:fs";
import { resultTableSection } from "./workflow-table";
import { decideToolUse, grantKeys, readToolFacts, refusalReason } from "./workflow-permissions";
import { askToolApproval } from "./workflow-tool-approval";
import { askRestartConfirm } from "./workflow-restart-confirm";
import { getExecutionMode, setExecutionMode } from "./execution-modes";
import { setWaitingWorkflows } from "./workflow-waiting";
import { appendWorkflowNote, registerWorkflowNoteRenderer } from "./workflow-note";
import { approvalRequestFor, askWorkflowApproval } from "./workflow-approval";
import { resolveStopTarget } from "./workflow-agent-stop";
import { sharedSlotPool } from "./workflow-slots";
import {
  workflowConfigFromEnv,
  type WorkflowAgentResult,
  type WorkflowAgentRunner,
  type WorkflowConfig,
  type WorkflowEvent,
  type WorkflowRunResult,
} from "./workflow-types";

export const WORKFLOW_TOOL_NAME = "workflow";

const DESCRIPTION = [
  "Run a small JavaScript workflow that fans work out to subagents and returns one result.",
  "Only the returned value reaches the conversation, so this is how you touch many files without flooding it.",
  "Inside the script: agent(prompt, { label, schema }), parallel([...]), pipeline(list, fn), phase(name), log(message).",
  "No imports, no filesystem, no network. 10 minutes wall clock, 1000 agents per run, 16 at a time.",
].join(" ");

const PARAMS = {
  type: "object",
  properties: {
    script: {
      type: "string",
      description:
        "JavaScript workflow body. Use `return` for the final value. Example: const files = await agent('list the .ts files under src/', { schema: { type: 'object', required: ['files'], properties: { files: { type: 'array', items: { type: 'string' } } } } }); return files.data.files;",
    },
    name: { type: "string", description: "Short name for this workflow, for /workflows." },
    args: { description: "Any JSON value; the script reads it as `args`." },
    background: {
      type: "boolean",
      description:
        "Default true: the tool returns at once and the run continues while you talk (like Claude Code). Use false only when the caller needs the value in this turn.",
    },
    resumeFrom: {
      type: "string",
      description:
        "Resume a saved run by its id (for example wf_qhj6qy01). The script is replayed and every finished agent that has not changed is answered from the journal instead of the model. `script` is then ignored.",
    },
    scriptFile: {
      type: "string",
      description:
        "Run a script saved on disk, by path or by name (for example two-looks). The file is read here, so the script is used exactly as it is on disk and never retyped. `script` is then ignored.",
    },
  },
  required: [],
} as const;

/** The last run, for `/workflows`. Kept small and never persisted. */
export interface LastWorkflowRun {
  name: string;
  result: WorkflowRunResult;
  at: number;
}

let lastRun: LastWorkflowRun | undefined;
/**
 * Job state belongs to ONE extension instance, not to the module.
 *
 * A module-level manager looked convenient and was wrong: pi builds its
 * extension list more than once, so a manager created by one instance was later
 * asked to deliver a report through another instance's API object — which throws
 * outside a live session. Per-instance state makes that impossible.
 */
interface WorkflowSessionState {
  manager?: WorkflowJobManager;
  toolCtx?: ExtensionToolContext;
  publisher?: (force?: boolean) => void;
  lastStatusAt: number;
}

/** Give a settled job's slots back. A cancelled job keeps none of them. */
function reclaimSlots(job: WorkflowJob, state: WorkflowSessionState): void {
  job.running = 0;
  if (state.publisher) setTimeout(() => state.publisher?.(true), 0).unref?.();
}

/** A result-shaped view of a job that may still be running. */
export function resultFromJob(job: WorkflowJob): WorkflowRunResult {
  return {
    ok: job.state === "done",
    value: job.result?.value,
    error: job.error,
    agents: job.agents,
    phases: job.phases,
    phaseStats: job.phaseStats,
    logs: job.recent.filter((event) => event.type === "log").map((event) => (event as { message: string }).message),
    durationMs: (job.finishedAt ?? Date.now()) - job.startedAt,
    truncated: false,
    tokens: job.tokens,
  };
}

/** Test hook: forget the shared last run. */
export function resetWorkflowJobs(): void {
  lastRun = undefined;
}

export function getLastWorkflowRun(): LastWorkflowRun | undefined {
  return lastRun;
}

export function resetLastWorkflowRun(): void {
  lastRun = undefined;
}

/** Total agents, tokens and failures for a phase table; shared by both views. */
function phaseLines(result: WorkflowRunResult, maxBar: number): string[] {
  if (result.phaseStats.length === 0) return [];
  const lines: string[] = [];
  const labelWidth = Math.max(...result.phaseStats.map((stat) => stat.name.length), 6);
  for (const stat of result.phaseStats) {
    const count = `${stat.agents} agent${stat.agents === 1 ? "" : "s"}`;
    const failed = stat.failed > 0 ? ` ${cross()} ${stat.failed}` : "";
    const tokens = formatTokens(stat.tokens).padStart(6);
    const bar = tokenBar(stat.tokens, maxBar, 10);
    lines.push(`  ${pad(phaseMark(stat.name), labelWidth + 4)} ${pad(count, 11)}${pad(failed, 6)} ${bar} ${tokens}`);
  }
  return lines;
}

/** Worker rows: who ran, how long, how much they burned. */
function agentLines(result: WorkflowRunResult, maxTokens: number, limit: number): string[] {
  const rows = [...result.agents].sort((a, b) => (b.usage?.total ?? 0) - (a.usage?.total ?? 0));
  const shown = limit > 0 ? rows.slice(0, limit) : rows;
  const nameWidth = Math.min(46, Math.max(12, ...shown.map((agent) => agent.label.length)));
  return shown.map((agent) => {
    // `↺` marks an agent whose answer came from the journal, not a fresh call.
    // A stop is neither a tick nor a cross, so it gets its own glyph; a report
    // that called it a failure would be telling you off for your own decision.
    const mark = agent.stopped
      ? stoppedMark()
      : agent.replayed
        ? replayMark()
        : agent.ok
          ? tick()
          : cross();
    const depth = agent.depth > 1 ? "  ".repeat(agent.depth - 1) + "└ " : "";
    const label = agent.label.length > nameWidth ? `${agent.label.slice(0, nameWidth - 1)}…` : agent.label;
    const tokens = formatTokens(agent.usage?.total ?? 0).padStart(6);
    const bar = tokenBar(agent.usage?.total ?? 0, maxTokens, 8);
    const time = formatDuration(agent.durationMs).padStart(6);
    const why = agent.error ? `  ${agent.error}` : "";
    // A restart is new work, so the row says so. An edited task says so too: the
    // words changed, and a report that hid that would misdescribe the answer.
    const again = agent.restarted ? (agent.attempts?.at(-1)?.prompt !== undefined ? "  ran again, task edited" : "  ran again") : "";
    return `  ${mark} ${pad(depth + label, nameWidth + 4)} ${bar} ${tokens} ${time}${why}${again}`;
  });
}

/** How the whole run is written into the chat. One report, no agent transcripts. */
export function renderWorkflowReport(name: string, result: WorkflowRunResult): string {
  const failed = result.agents.filter((agent) => !agent.ok).length;
  const tokens = formatTokens(result.tokens.total);
  const replayed = result.replayed ?? 0;
  const lines: string[] = [];
  lines.push(
    `${RUNNING} workflow ${name}: ${result.agents.length} agent${result.agents.length === 1 ? "" : "s"} in ${formatDuration(
      result.durationMs,
    )} · ${tokens} tokens${failed > 0 ? ` · ${failed} failed` : ""}${
      replayed > 0 ? ` · ${replayMark()} ${replayed} replayed` : ""
    }`,
  );

  const maxPhase = Math.max(0, ...result.phaseStats.map((stat) => stat.tokens));
  lines.push(...phaseLines(result, maxPhase));

  if (result.truncated) lines.push("some output was dropped at the cap");

  if (!result.ok) {
    lines.push("", `failed: ${result.error ?? "unknown error"}`);
    if (result.agents.length > 0) {
      lines.push("", "agents:");
      lines.push(...agentLines(result, maxTokens(result), 20));
    }
    return lines.join("\n");
  }

  const value = result.value;
  let body: string;
  if (typeof value === "string") body = value;
  else body = JSON.stringify(value, null, 2) ?? "(no value)";
  // The chat does not need ten thousand lines; the runtime already capped this.
  if (body.length > 8000) body = `${body.slice(0, 8000)}\n… (${body.length - 8000} more characters in the run details)`;
  lines.push("", body);
  const logs = result.logs.filter((line) => !line.startsWith("[log limit reached"));
  if (logs.length > 0) {
    lines.push("", "--- log ---");
    lines.push(...logs.slice(-15));
  }
  // A fan-out answers the same questions about N things. A table is how a
  // person compares them; prose is how they stop trying. Only agents that
  // really returned structured data are tabulated — nothing is invented.
  lines.push(...resultTableSection(result.agents));
  return lines.join("\n");
}

function maxTokens(result: WorkflowRunResult): number {
  return Math.max(0, ...result.agents.map((agent) => agent.usage?.total ?? 0));
}

/** One line per job: state, name, agents, tokens, time. */
export function jobLine(job: WorkflowJob): string {
  const mark =
    job.state === "done"
      ? tick()
      : job.state === "failed"
        ? cross()
        : job.state === "cancelled"
          ? cross()
          : RUNNING;
  const elapsed = formatDuration((job.finishedAt ?? Date.now()) - job.startedAt);
  const counts =
    job.state === "running" || job.state === "queued"
      ? `${job.running} running · ${job.done} done`
      : `${job.done} agent${job.done === 1 ? "" : "s"}${job.failed > 0 ? ` · ${cross()} ${job.failed}` : ""}`;
  const state = job.state === "failed" ? `  ${job.error ?? "failed"}` : "";
  return `  ${mark} ${pad(job.id, 12)} ${pad(job.name.slice(0, 26), 27)} ${pad(counts, 20)} ${pad(
    `${formatTokens(job.tokens.total)} tokens`,
    12,
  )} ${elapsed}${state}`;
}

/** `/workflows` with live or finished jobs. Pure, so it is testable. */
export function renderJobList(active: WorkflowJob[], all: WorkflowJob[]): string {
  const lines: string[] = [];
  if (active.length > 0) {
    const running = active.reduce((total, job) => total + job.running, 0);
    const done = active.reduce((total, job) => total + job.done, 0);
    const tokens = active.reduce((total, job) => total + job.tokens.total, 0);
    lines.push(
      `${RUNNING} ${active.length} workflow${active.length === 1 ? "" : "s"} running · ${running} agents · ${done} done · ${formatTokens(
        tokens,
      )} tokens`,
    );
    lines.push(...active.map(jobLine));
    lines.push("", "/workflows <id> for detail · /workflows stop <id> to stop · /workflows stop <id> <agent> for one");
    return lines.join("\n");
  }
  lines.push(`${RUNNING} no workflow is running`);
  const recent = all.slice(0, 8);
  if (recent.length > 0) {
    lines.push("", "recent:");
    lines.push(...recent.map(jobLine));
    lines.push("", "/workflows <id> for detail");
  } else {
    lines.push("", "Start one by writing the word ultracode in a prompt.");
  }
  return lines.join("\n");
}

/** One job, in detail: phases with tokens, then agents sorted by cost. */
export function renderJobDetail(job: WorkflowJob): string {
  // Always rebuilt from the job, never the settled snapshot: an agent can be run
  // again after the run ended, and a detail line that still shows the old token
  // count would hide the second charge.
  const result = resultFromJob(job);
  const live = job.state === "running" || job.state === "queued" || job.state === "paused";
  // A live job is not a finished job, and calling it "failed" would be a lie that
  // makes people stop a healthy run.
  const head = renderWorkflowDetail({ name: job.name, result, at: job.startedAt }, { live: live ? job.state : undefined });
  const state = live ? `status: ${job.state} (${job.done} done, ${job.running} running)` : "";
  const replay = job.resumedFrom
    ? `resumed from ${job.resumedFrom}: ${job.replayed} agent${job.replayed === 1 ? "" : "s"} replayed, ${formatTokens(
        job.replayedTokens.total,
      )} tokens not spent again`
    : "";
  const paths = job.journalPath ? [`journal: ${job.journalPath}`] : [];
  return [head, state, replay, ...paths].filter(Boolean).join("\n");
}

/** What `/workflows` prints: the last run, in detail. Pure, so it is testable. */
export function renderWorkflowDetail(run: LastWorkflowRun | undefined, options: { live?: string } = {}): string {
  if (!run) {
    return [
      "No workflow has run in this session.",
      "",
      "Start one by writing the word ultracode in a prompt, for example:",
      "  ultracode audit every route in src/routes for a missing auth check",
    ].join("\n");
  }
  const { result } = run;
  const failed = result.agents.filter((agent) => !agent.ok && !agent.stopped).length;
  const lines = [
    `${RUNNING} ${run.name} — ${options.live ?? (result.ok ? "finished" : "failed")}`,
    `agents ${result.agents.length}${failed > 0 ? ` (${cross()} ${failed} failed)` : ""} · ${formatDuration(
      result.durationMs,
    )} · ${formatTokens(result.tokens.total)} tokens`,
    `in ${formatTokens(result.tokens.input)} / out ${formatTokens(result.tokens.output)}`,
  ];
  if ((result.replayed ?? 0) > 0) {
    lines.push(
      `${replayMark()} ${result.replayed} replayed from the journal (${formatTokens(
        result.replayedTokens?.total ?? 0,
      )} tokens not spent again)`,
    );
  }
  if (result.error) lines.push(`error: ${result.error}`);
  if (result.truncated) lines.push("note: some output was dropped at the cap");

  if (result.phaseStats.length > 0) {
    lines.push("", "phases:");
    lines.push(...phaseLines(result, maxTokens(result)));
  }
  if (result.agents.length > 0) {
    lines.push("", "agents (most expensive first):");
    lines.push(...agentLines(result, maxTokens(result), 0));
  }
  if (result.logs.length > 0) {
    lines.push("", "log:");
    lines.push(...result.logs.slice(-10));
  }
  return lines.join("\n");
}

export interface CreateWorkflowToolOptions {
  runner?: SubagentRunner;
  /** Where journals go. Defaults to the CLI's agent dir at call time. */
  agentDir?: string;
  registry?: AgentRegistry;
  config?: WorkflowConfig;
  userHomeDir?: string;
  now?: () => number;
  /** Live events, for the Hub or a future panel. */
  onEvent?: (event: WorkflowEvent) => void;
}

/**
 * The context window of the model an agent ran on.
 *
 * A routed agent names its own model; otherwise the session's. When the registry
 * cannot answer, the answer is `undefined` — an invented size would be worse than
 * no size, and the header says the model name alone.
 */
function contextWindowFor(ctx: ExtensionToolContext, model?: string): number | undefined {
  try {
    const session = (ctx.model as { contextWindow?: number; id?: string } | undefined) ?? undefined;
    const wanted = (model ?? "").trim();
    if (wanted === "" || wanted === session?.id) {
      const size = session?.contextWindow;
      return typeof size === "number" && size > 0 ? size : undefined;
    }
    const registry = ctx.modelRegistry as
      | { find?: (provider: string, id: string) => { contextWindow?: number } | undefined; getAll?: () => Array<{ id: string; contextWindow?: number }> }
      | undefined;
    const found = registry?.find?.("qronos", wanted) ?? registry?.getAll?.().find((entry) => entry.id === wanted);
    const size = found?.contextWindow;
    return typeof size === "number" && size > 0 ? size : undefined;
  } catch {
    return undefined;
  }
}

/** The name to put on a card before the script's own `meta.name` is known. */
function runNameOf(name: string): string {
  const clean = name.trim();
  return clean === "" || clean === "workflow" ? "workflow" : clean;
}

export function createWorkflowToolExtension(options: CreateWorkflowToolOptions = {}): InlineExtension {
  const runner = options.runner ?? defaultSubagentRunner;
  const registry = options.registry ?? new AgentRegistry();
  const config = options.config ?? workflowConfigFromEnv();
  const userHome = options.userHomeDir ?? homedir();
  const now = options.now ?? Date.now;

  return {
    name: "qronos-workflow",
    factory(qronos: ExtensionAPI) {
      // Registered before anything can append a note, so the first
      // "dialog dismissed" line is drawn instead of silently stored.
      registerWorkflowNoteRenderer(qronos as never);

      /** One subagent, mapped onto the workflow result shape. */
      const runAgentOnce = async (
        request: Parameters<WorkflowAgentRunner>[0],
        signal: AbortSignal,
        ctx: ExtensionToolContext,
      ): Promise<WorkflowAgentResult> => {
        if (signal.aborted) return { ok: false, text: "", error: "stopped" };
        const base: AgentDefinition = { ...BUILTIN_AGENTS["general-purpose"]!, source: "builtin" };
        // A builtin definition carries a read-only allow-list. A workflow agent
        // gets the parent session's pool instead, because here the permission
        // door — not the allow-list — is what decides whether a tool may run, and
        // a door nobody can reach guards nothing. A named agent type keeps its own
        // narrowing, since the caller chose it on purpose.
        //
        // `acceptEdits` marks the agent as one that may hold mutating tools. It is
        // not a permission grant: every such call still walks through the door and
        // meets the chat's mode, so `plan` refuses a write and `manual` asks.
        const definition: AgentDefinition = request.agentType
          ? { ...base, name: request.agentType, permissionMode: "acceptEdits" }
          : { ...base, tools: undefined, permissionMode: "acceptEdits" };
        try {
          const outcome = await runner({
            agentDef: definition,
            prompt: request.prompt,
            description: request.label ?? "workflow task",
            cwd: ctx.cwd || process.cwd(),
            // Every tool this subagent runs goes through the permission door.
            ctx: gatedContext(ctx, request),
            outputSchema: request.schema,
            model: request.model,
            // The parent's pool, so a subagent holds exactly what the chat holds
            // and never more. Without this a workflow agent could only read,
            // which would leave the permission door below with nothing to guard.
            parentTools: (ctx.tools ?? []).map((tool) => tool.name),
            // Writes are allowed to be *offered*; whether one runs is the door's
            // decision, taken per tool call in the chat's own mode.
            parentCanWrite: true,
            // The panel's Activity block. A display hook: if it ever throws, the
            // agent keeps working and only the row is lost.
            onEvent: (event) => {
              if (!event.tool) return;
              try {
                request.onActivity?.({ tool: event.tool, turns: event.turns, detail: event.args });
              } catch {
                // display only
              }
            },
          });
          // Tokens come from the subagent runner; without them the report could
          // not say who did how much work.
          const usage = outcome.usage
            ? { input: outcome.usage.input, output: outcome.usage.output, total: outcome.usage.total }
            : undefined;
          // How much room the model had, read from the registry now, because a
          // later `/workflows` read has no registry to ask. Unknown is fine: the
          // header then shows the name alone, never a made-up number.
          const contextWindow = contextWindowFor(ctx, request.model);
          if (outcome.structured) {
            return { ok: true, text: outcome.output, data: outcome.structured.value, usage, contextWindow };
          }
          if (outcome.schemaIssues && outcome.schemaIssues.length > 0) {
            return {
              ok: false,
              text: outcome.output,
              usage,
              contextWindow,
              error: `schema not satisfied: ${outcome.schemaIssues
                .slice(0, 3)
                .map((issue) => `${issue.path || "value"} ${issue.message}`)
                .join("; ")}`,
            };
          }
          return { ok: true, text: outcome.output, usage, contextWindow };
        } catch (error) {
          return { ok: false, text: "", error: error instanceof Error ? error.message : String(error) };
        }
      };

      /** A tool result that says "no" without throwing into the agent. */
      const refuseTool = (name: string, reason: string) => ({
        result: { content: [{ type: "text" as const, text: `No: ${reason}` }], isError: true },
        isError: true,
      });

      /**
       * Wrap the tool context so a subagent's tool call meets the chat's own
       * permission mode.
       *
       * Why a wrapper and not a check inside the subagent runner: the runner is
       * shared with the chat's own `agent` tool, and a workflow is the only place
       * with a run to grant against. Here the decision has a run, a name for the
       * card, and somewhere to keep "allow for this run".
       */
      const gatedContext = (ctx: ExtensionToolContext, request: Parameters<WorkflowAgentRunner>[0]): ExtensionToolContext => {
        // A host with no tool executor cannot run a tool at all, so there is
        // nothing to gate: pass the context through instead of crashing.
        if (typeof ctx.executeTool !== "function") return ctx;

        // The old behaviour, for a user who wants it and knows what it means.
        if ((process.env.QRONOS_WORKFLOW_TOOLS ?? "").trim() === "0") return ctx;
        const base = ctx.executeTool.bind(ctx);
        const executeTool = async (name: string, args: unknown) => {
          const mode = getExecutionMode();
          const facts = readToolFacts({ name, args: (args ?? {}) as Record<string, unknown>, cwd: ctx.cwd || process.cwd() });
          const grants = request.toolGrants?.() ?? new Set<string>();
          const verdict = decideToolUse(mode, facts, grants);
          if (verdict === "allow") return base(name, args);
          if (verdict === "refuse") return refuseTool(name, refusalReason(mode, facts));

          // The runtime owns the ask and the grants. No ask means nobody to
          // question, and silence must never run a tool.
          if (!request.approveTool) return refuseTool(name, refusalReason(mode, facts));
          const decision = await request.approveTool({ ...facts, name });
          if (!decision.approved) return refuseTool(name, refusalReason(mode, facts));
          if (decision.switchToAuto) {
            try {
              setExecutionMode("auto");
            } catch {
              // A host without a mode slider still runs the tool: the user said yes.
            }
          }
          return base(name, args);
        };
        // A proxy, not a spread: a spread loses the fields the host keeps behind
        // prototype getters (`tools` is one), and that cost every workflow run its
        // first tool call. See src/context-proxy.ts.
        return withToolExecutor(ctx, executeTool as never);
      };

      // The job manager is per extension instance, so the journals, the status
      // line and the "one report per job" rule all belong to this session.
      const state: WorkflowSessionState = { lastStatusAt: 0 };

      /**
       * The ask, for one named run.
       *
       * Both paths need it — the job manager for a background run and the
       * foreground runtime below — so it is written once. Two copies would drift,
       * and the one that drifted would be the path where a tool ran unguarded.
       */
      const askFor =
        (workflow: string) =>
        async ({ facts, asked, total }: { facts: Parameters<typeof askToolApproval>[1]["facts"]; asked: number; total?: number }) => {
          const answer = await askToolApproval(state.toolCtx, { workflow, facts, asked, total });
          const approved = answer.answer !== "No";
          return {
            approved,
            // "Yes, allow ... for this run" is the only answer that remembers
            // anything, and what it remembers dies with the run.
            grant: approved && answer.answer === "yes-for-run" ? grantKeys(facts) : undefined,
            switchToAuto: approved && answer.answer === "yes-and-auto",
            skipped: answer.skipped,
          };
        };

      const managerFor = (): WorkflowJobManager => {
        if (state.manager) return state.manager;
        state.manager = new WorkflowJobManager({
          agentDir: options.agentDir,
          config,
          now,
          runAgent: (request, signal) => {
            const ctx = state.toolCtx;
            if (!ctx) return Promise.resolve({ ok: false, text: "", error: "no session context" });
            return runAgentOnce(request, signal, ctx);
          },
          // Every tool a subagent runs that the mode says to question lands
          // here, as a card in the chat. The panel stays read-only.
          approveTool: ({ facts, asked, total, workflow }) => askFor(workflow)({ facts, asked, total }),
          // The waiting row above the editor follows this: one hook, so a run
          // that ends by being cancelled cannot leave the row behind.
          onActiveChange: (active) => {
            try {
              setWaitingWorkflows(active);
            } catch {
              // A display hook must never break a run.
            }
          },
          onSettle: (job) => {
            const result = job.result ?? resultFromJob(job);
            lastRun = { name: job.name, result, at: now() };
            reclaimSlots(job, state);
            try {
              state.toolCtx?.ui?.notify?.(
                job.state === "done"
                  ? `✻ workflow ${job.name} finished: ${job.agents.length} agents, ${formatTokens(job.tokens.total)} tokens`
                  : `✗ workflow ${job.name} ${job.state}: ${job.error ?? "unknown error"}`,
                job.state === "done" ? "info" : "warning",
              );
            } catch {
              // A terminal without notifications is not an error.
            }
            // Claude Code delivers a task-notification into the chat. This is
            // the same idea: a custom message, next turn, marked as data.
            try {
              qronos.sendMessage(
                {
                  customType: "qronos-workflow-report",
                  content: renderWorkflowReport(job.name, result),
                  display: true,
                  details: { job: job.id, state: job.state },
                },
                { deliverAs: "nextTurn" },
              );
            } catch (error) {
              // Older hosts have no sendMessage; /workflows still shows it.
              if (process.env.QRONOS_DEBUG_WORKFLOW) {
                console.error("[qronos-workflow] delivery failed:", (error as Error)?.message, (error as Error)?.stack);
              }
            }
          },
        });
        return state.manager;
      };

      qronos.registerTool({
        name: WORKFLOW_TOOL_NAME,
        label: "Workflow",
        description: DESCRIPTION,
        promptSnippet:
          "Run a JavaScript workflow that fans work out to subagents and returns only the final result.",
        parameters: PARAMS as unknown as Record<string, unknown>,
        async execute(_toolCallId: string, params: any, _signal: AbortSignal, _onUpdate: unknown, ctx: ExtensionToolContext): Promise<any> {
          let script = typeof params?.script === "string" ? params.script : "";
          let name = (typeof params?.name === "string" && params.name.trim() !== "" ? params.name : "workflow").slice(0, 60);
          const resumeFrom = typeof params?.resumeFrom === "string" ? params.resumeFrom.trim() : "";
          const scriptFile = typeof params?.scriptFile === "string" ? params.scriptFile.trim() : "";

          // A saved script is read from disk, so the file the user edited is the
          // file that runs: no retyping, no drift between the two.
          if (scriptFile !== "") {
            const dir = scriptDirFor(process.cwd());
            const saved =
              resolveSavedScript(dir, scriptFile) ??
              // A full path is not a name, so it is read as it is, and the name
              // comes from the file itself.
              (readSavedScript(scriptFile) !== undefined
                ? { name: scriptFile.split(/[\\/]/).at(-1)!.replace(/\.js$/, ""), path: scriptFile, bytes: 0 }
                : undefined);
            if (!saved) {
              return {
                content: [{ type: "text" as const, text: `Error: no saved script "${scriptFile}". /workflows scripts lists them.` }],
                details: { ok: false, reason: "no-script-file" },
              };
            }
            const text = readSavedScript(saved.path);
            const problem = scriptProblem(text);
            if (problem) {
              return {
                content: [{ type: "text" as const, text: `Error: ${saved.path}: ${problem}.` }],
                details: { ok: false, reason: "bad-script-file" },
              };
            }
            script = text!;
            if (name === "workflow") name = (saved.name || "workflow").slice(0, 60);
          }

          if (script.trim() === "" && resumeFrom === "") {
            return {
              content: [{ type: "text" as const, text: "Error: the workflow needs a script (or a resumeFrom id, or a scriptFile)." }],
              details: { ok: false, reason: "no-script" },
            };
          }

          state.toolCtx = ctx;

          // Ask before spending money. Claude Code does this for every dynamic
          // workflow; we ask from three written agent calls upwards, so a tiny
          // run is not interrupted. `QRONOS_WORKFLOW_APPROVE` changes it:
          // `always`, `never`, or the default `ask`.
          //
          // A resume replays a script the user has already approved, so it is
          // never asked about twice.
          let approvedScript = script;
          let approvedDescription: string | undefined;
          if (resumeFrom === "") {
            const request = approvalRequestFor(script, name !== "workflow" ? name : undefined);
            const lastTokens = lastRun?.result.tokens?.total;
            const outcome = await askWorkflowApproval(ctx, { ...request, lastTokens });
            if (!outcome.approved) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: `${cross()} workflow ${request.name} was not started: the approval card was declined. Nothing ran and nothing was saved.`,
                  },
                ],
                details: { ok: false, reason: "declined", name: request.name },
              };
            }
            approvedScript = outcome.script;
            approvedDescription = outcome.description;
          }

          // A live line while work is happening: running, done and tokens.
          // Throttled, because a tick per agent event would fight the renderer.
          const publishStatus = (force = false) => {
            const stamp = now();
            if (!force && stamp - state.lastStatusAt < 250) return;
            state.lastStatusAt = stamp;
            const jobs = managerFor().active();
            if (jobs.length === 0) {
              try {
                ctx.ui?.setStatus?.("qronos-workflow", undefined);
              } catch {
                // decoration only
              }
              return;
            }
            const running = jobs.reduce((total, job) => total + job.running, 0);
            const done = jobs.reduce((total, job) => total + job.done, 0);
            const tokens = jobs.reduce((total, job) => total + job.tokens.total, 0);
            const headline = jobs.length === 1 ? jobs[0]!.name : `${jobs.length} workflows`;
            const phase = jobs.length === 1 ? jobs[0]!.phases.at(-1) : undefined;
            const paused = jobs.some((job) => job.state === "paused");
            const text = `${paused ? "⏸" : RUNNING} ${headline}${phase ? ` · ${phase}` : ""}${
              paused ? " · paused" : ""
            } · ${running} running · ${done} done · ${formatTokens(tokens)} tokens`;
            try {
              ctx.ui?.setStatus?.("qronos-workflow", text);
            } catch {
              // decoration only
            }
          };
          state.publisher = publishStatus;

          // Foreground: the caller wants the value inside this turn.
          if (params?.background === false) {
            const runtime = new WorkflowRuntime({
              config,
              now,
              args: params?.args,
              slots: sharedSlotPool(),
              onEvent: (event) => {
                options.onEvent?.(event);
                if (event.type === "agent_end") publishStatus();
              },
              approveTool: askFor(runNameOf(name)),
              runAgent: (request, signal) => runAgentOnce(request, signal, ctx),
            });
            const result = await runtime.run(approvedScript);
            try {
              ctx.ui?.setStatus?.("qronos-workflow", undefined);
            } catch {
              // decoration only
            }
            const runName = name !== "workflow" ? name : (result.meta.name ?? name);
            lastRun = { name: runName, result, at: now() };
            return {
              content: [{ type: "text" as const, text: renderWorkflowReport(runName, result) }],
              details: {
                ok: result.ok,
                name: runName,
                background: false,
                agents: result.agents.length,
                phases: result.phases,
                durationMs: result.durationMs,
                tokens: result.tokens,
                phaseStats: result.phaseStats,
                truncated: result.truncated,
                error: result.error ?? null,
              },
            };
          }

          // Background: Claude Code's shape. The tool returns at once, the run
          // continues, and the report arrives as a message on the next turn.
          managerFor().prune();
          const job = managerFor().launch({ script: approvedScript, name, args: params?.args, resumeFrom: resumeFrom || undefined });
          publishStatus(true);
          const queued = [
            `${RUNNING} workflow ${job.name} launched as ${job.id}${
              job.resumedFrom ? ` (replaying ${job.resumedFrom})` : ""
            }`,
            "It runs in the background; your next message arrives as usual.",
            `/workflows          watch it (agents, phases, tokens)`,
            `/workflows ${job.id}  one job in detail`,
            `/workflows pause ${job.id}  /workflows resume ${job.id}`,
            `/workflows stop ${job.id}  stop it  ·  /workflows stop ${job.id} <agent>  stop one`,
          ].join("\n");

          return {
            content: [{ type: "text" as const, text: queued }],
            details: {
              ok: true,
              background: true,
              queued: true,
              job: job.id,
              name: job.name,
              agents: 0,
              phases: [],
              tokens: { input: 0, output: 0, total: 0 },
              error: null,
            },
          };
        },
      });

      qronos.registerCommand("workflows", {
        description: "Watch workflow runs: pause, resume, stop, save a script; see what is saved on disk",
        handler: async (args: string, ctx: ExtensionCommandContext) => {
          const words = (args ?? "").trim().split(/\s+/).filter(Boolean);
          const manager = state.manager;

          /**
           * Ask, then run one agent again. One function for the `r` key inside the
           * panel and for `/workflows restart`, so the two cannot drift.
           *
           * The question comes first because a restart spends tokens. Answering
           * "no" is the default, and a host that cannot show the card gets a no.
           */
          const restartOne = async (jobId: string, agentId: string): Promise<{ ok: boolean; error?: string; edited?: boolean }> => {
            const job = manager?.get(jobId);
            if (!job) return { ok: false, error: "no such run" };
            if (!manager) return { ok: false, error: "no workflow manager yet" };
            const agent = job.agents.find((entry) => entry.id === agentId);
            if (!agent) return { ok: false, error: "no such agent in this run" };
            const answer = await askRestartConfirm(ctx, {
              label: agent.label,
              model: agent.model,
              tokens: agent.usage?.total,
              // The task goes on the card, so "edit" starts from what really ran.
              prompt: agent.prompt,
            });
            if (!answer.approved) return { ok: false, error: "not restarted: you said no" };
            const outcome = await manager.restartAgent(jobId, agentId, answer.prompt);
            return outcome.ok ? { ok: true, edited: answer.prompt !== undefined } : { ok: false, error: outcome.error };
          };

          // The failed ones, one at a time, behind one card. Same three rules as the
          // phase rerun; the only difference is which agents are chosen.
          const retryFailedOne = async (jobId: string): Promise<RetryOutcome> => {
            if (!manager) return { ok: false, error: "no workflow manager yet" };
            const job = manager.get(jobId);
            const problem = retryRefusal(job);
            if (problem || !job) return { ok: false, error: problem ?? "no such run" };
            const agents = failedAgents(job);
            const yes = await askConfirm(ctx as never, {
              title: retryFailedTitle(job),
              lines: retryFailedLines(job),
              yes: `Yes, run ${agents.length === 1 ? "it" : "them"} again`,
              no: "No, leave them",
            });
            if (!yes) return { ok: false, error: "not run again: you said no" };
            return retryFailed(job, (agentId) => manager.restartAgent(jobId, agentId));
          };

          // A whole phase, one agent at a time, behind one card. The card comes
          // first because this spends money once per agent, and the number of
          // agents is the number a person needs before saying yes.
          const rerunPhaseOne = async (jobId: string, phase: string): Promise<PhaseRerunOutcome> => {
            if (!manager) return { ok: false, error: "no workflow manager yet" };
            const job = manager.get(jobId);
            const problem = phaseRerunRefusal(job, phase);
            if (problem || !job) return { ok: false, error: problem ?? "no such run" };
            const agents = agentsOfPhase(job, phase);
            const yes = await askConfirm(ctx as never, {
              title: phaseRerunTitle(phase),
              lines: phaseRerunLines(job, phase),
              yes: `Yes, run ${agents.length} agent${agents.length === 1 ? "" : "s"} again`,
              no: "No, leave them",
            });
            if (!yes) return { ok: false, error: "not run again: you said no" };
            return rerunPhase(job, phase, (agentId) => manager.restartAgent(jobId, agentId));
          };

          // Saving a script is one function for the `s` key and the command: two
          // ways to do the same thing must not drift.
          const saveScript = (jobId: string): string | undefined => {
            const job = manager?.get(jobId);
            if (!job) return undefined;
            try {
              const saved = saveWorkflowScript({ cwd: process.cwd(), name: job.name, script: job.script });
              return saved.path;
            } catch {
              return undefined;
            }
          };

          // `/workflows panel`: the live overlay, the same thing Alt+W opens.
          if (words[0] === "panel") {
            const shown = await openWorkflowPanel(ctx, managerFor(), (ctx as { theme?: unknown }).theme as never, {
              saveScript,
              restartAgent: restartOne,
              rerunPhase: rerunPhaseOne,
              retryFailed: retryFailedOne,
              stopAgent: (jobId: string, agentId: string) => managerFor().stopAgent(jobId, agentId),
            });
            // Only a panel that really opened can be dismissed. In a host with
            // no overlays there is nothing to close, so there is nothing to say.
            if (shown) appendWorkflowNote(qronos, "Dynamic workflows dialog dismissed");
            return;
          }

          // `/workflows save <id>`: keep the script in the project.
          if (words[0] === "save") {
            const job = words[1]
              ? manager?.get(words[1])
              : (manager?.active()[0] ?? manager?.list()[0]);
            if (!job) {
              ctx.ui.notify("No workflow to save yet.", "info");
              return;
            }
            const path = saveScript(job.id);
            ctx.ui.notify(
              path
                ? [`Saved ${job.name} to ${path}`, "Run it again by pasting the file into a prompt, or git add it and keep it with the project."].join("\n")
                : `Could not write the script for ${job.id}.`,
              path ? "info" : "warning",
            );
            return;
          }

          // `/workflows restart <id> <agent>`: run one agent again. It costs
          // tokens, so the card asks first; the panel's `r` does the same thing.
          if (words[0] === "restart") {
            // The run is optional: `restart alpha` is about the newest run, and a
            // word that is not a job id is read as an agent name instead.
            const job = (words[1] ? manager?.get(words[1]) : undefined) ?? manager?.list()[0];
            if (!job) {
              ctx.ui.notify(
                [
                  "No workflow to restart.",
                  "A run started with background: false finishes inside the turn and is not kept as a job, so there is nothing to re-run its agents from.",
                  "Start one in the background, then /workflows to see it.",
                ].join("\n"),
                "info",
              );
              return;
            }
            const name = words[2] ?? (words[1] && words[1] !== job.id ? words[1] : undefined);
            const agent =
              (name ? job.agents.find((entry) => entry.id === name) : undefined) ??
              (name ? job.agents.find((entry) => entry.label === name) : undefined) ??
              job.agents.at(-1);
            if (!agent) {
              ctx.ui.notify(`${job.id} has no finished agent to restart yet.`, "warning");
              return;
            }
            const outcome = await restartOne(job.id, agent.id);
            ctx.ui.notify(
              outcome.ok
                ? [
                    `Ran "${agent.label}" again in ${job.id}${outcome.edited ? " with the task you edited" : ""}.`,
                    "Its tokens went up and the run's total was not rewritten.",
                  ].join("\n")
                : outcome.error ?? "It did not run.",
              outcome.ok ? "info" : "warning",
            );
            return;
          }

          // `/workflows pause <id>`: stop starting agents, keep what is running.
          if (words[0] === "pause") {
            const job = words[1] ? manager?.get(words[1]) : manager?.active().find((entry) => entry.state === "running");
            if (!job) {
              ctx.ui.notify(words[1] ? `No workflow with id ${words[1]}.` : "No workflow is running.", "info");
              return;
            }
            if (!manager?.pause(job.id)) {
              ctx.ui.notify(`${job.id} is ${job.state}, not running.`, "info");
              return;
            }
            state.publisher?.(true);
            ctx.ui.notify(`Paused ${job.id}. ${job.running} agent(s) in flight will finish. /workflows resume ${job.id} to carry on.`, "info");
            return;
          }

          // `/workflows resume <id>`: carry on where a pause left off. If that run
          // is not live any more, replay it from its journal instead.
          if (words[0] === "resume") {
            const target = words[1];
            const job = target ? manager?.get(target) : manager?.active().find((entry) => entry.state === "paused");
            if (job && manager?.resume(job.id)) {
              state.publisher?.(true);
              ctx.ui.notify(`Resumed ${job.id}. Nothing is replayed: it carries on from the pause.`, "info");
              return;
            }
            const saveId = target ?? job?.id;
            if (!saveId) {
              ctx.ui.notify("No paused workflow is running. Name a saved run: /workflows saved lists them.", "info");
              return;
            }
            try {
              const replayed = managerFor().launch({ script: "", resumeFrom: saveId });
              ctx.ui.notify(
                [`Replaying ${replayed.resumedFrom} as ${replayed.id}.`, "Finished agents that did not change come from the journal, so they cost nothing again."].join("\n"),
                "info",
              );
            } catch (error) {
              ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
            }
            return;
          }

          // `/workflows scripts`: the scripts you saved, newest first.
          if (words[0] === "scripts") {
            const dir = scriptDirFor(process.cwd());
            const scripts = listSavedScripts(dir);
            if (scripts.length === 0) {
              ctx.ui.notify(
                [`No scripts saved in this project yet.`, `A run is saved with \`s\` in the panel, or /workflows save <id>.`, `They live in ${dir}`].join("\n"),
                "info",
              );
              return;
            }
            const stamp = Date.now();
            const lines = [
              `saved scripts in ${dir}`,
              "",
              ...scripts.map((script) => `  ${pad(script.name.slice(0, 30), 31)} ${savedScriptLine({ ...script, name: "" }, stamp).replace(/^ · /, "")}`),
              "",
              `run one with /workflows run <name>`,
              `edit one with /workflows edit <name>`,
            ];
            ctx.ui.notify(lines.join("\n"), "info");
            return;
          }

          // `/workflows run <name>`: a saved script, run like any other workflow.
          //
          // A command handler cannot run tools — only the model can — so this does
          // not pretend to start a run by itself. It checks the file, then asks the
          // chat's own agent to call the tool with `scriptFile`, which reads the
          // exact text from disk and shows the normal approval card.
          if (words[0] === "run") {
            const dir = scriptDirFor(process.cwd());
            const script = words[1] ? resolveSavedScript(dir, words.slice(1).join(" ")) : undefined;
            if (!script) {
              const known = listSavedScripts(dir).map((entry) => entry.name);
              ctx.ui.notify(
                words[1]
                  ? [`No saved script called "${words.slice(1).join(" ")}".`, known.length > 0 ? `Saved: ${known.join(", ")}` : "Nothing is saved in this project yet."].join("\n")
                  : "Name a saved script: /workflows scripts lists them.",
                "info",
              );
              return;
            }
            const text = readSavedScript(script.path);
            const problem = scriptProblem(text);
            if (problem) {
              ctx.ui.notify(`${script.path}: ${problem}.`, "warning");
              return;
            }
            ctx.ui.notify(
              [`Starting ${script.name} from ${script.path}.`, "The card comes next; nothing runs until you answer it."].join("\n"),
              "info",
            );
            qronos.sendUserMessage(
              `Run the saved workflow script at ${script.path} by calling the ${WORKFLOW_TOOL_NAME} tool with scriptFile: "${script.path}". Use the file as it is; do not retype or change it.`,
            );
            return;
          }

          // `/workflows edit <name>`: change a saved script, and save only if you
          // say so. A file that is silently rewritten is a file you cannot trust.
          if (words[0] === "edit") {
            const dir = scriptDirFor(process.cwd());
            const script = words[1] ? resolveSavedScript(dir, words.slice(1).join(" ")) : undefined;
            if (!script) {
              ctx.ui.notify(
                words[1] ? `No saved script called "${words.slice(1).join(" ")}". /workflows scripts lists them.` : "Name a script: /workflows scripts lists them.",
                "info",
              );
              return;
            }
            const before = readSavedScript(script.path);
            if (before === undefined) {
              ctx.ui.notify(`${script.path} could not be read.`, "warning");
              return;
            }
            const edited = editTextInEditor(before, { fileName: `${script.name}.js` });
            if (edited === undefined) {
              ctx.ui.notify(`Nothing changed in ${script.path}.`, "info");
              return;
            }
            const save = await askConfirm(ctx, {
              title: "Save the change?",
              // The tail of the path, so the file name is not the part that is cut.
              lines: [shortPath(script.path), "the file on disk would be replaced"],
              yes: "Yes, save it",
              no: "No, leave the file alone",
            });
            if (!save) {
              ctx.ui.notify(`Not saved. ${script.path} is unchanged.`, "info");
              return;
            }
            try {
              writeFileSync(script.path, edited.endsWith("\n") ? edited : `${edited}\n`, "utf8");
            } catch (error) {
              ctx.ui.notify(`Could not save ${script.path}: ${error instanceof Error ? error.message : String(error)}`, "warning");
              return;
            }
            ctx.ui.notify(`Saved ${script.path}. Run it with /workflows run ${script.name}.`, "info");
            return;
          }

          // `/workflows saved`: runs on disk that can be resumed, even in a new session.
          if (words[0] === "saved") {
            const runs = managerFor().savedRuns();
            if (runs.length === 0) {
              ctx.ui.notify("No workflow run is saved on disk yet.", "info");
              return;
            }
            const lines = runs.slice(0, 12).map((run) => {
              const mark = run.finished ? (run.ok ? tick() : cross()) : RUNNING;
              const state = run.finished ? (run.ok ? "finished" : "failed") : "interrupted";
              return `  ${mark} ${pad(run.runId, 12)} ${pad(run.name.slice(0, 26), 27)} ${pad(
                `${run.agents} agents`,
                10,
              )} ${state}${run.resumedFrom ? ` (from ${run.resumedFrom})` : ""}`;
            });
            lines.push("", `resume one with /workflows resume <id>`);
            ctx.ui.notify(lines.join("\n"), "info");
            return;
          }

          // `/workflows retry <id>`: run the failed agents again, and only those.
          if (words[0] === "retry") {
            const job = words[1] ? manager?.get(words[1]) : undefined;
            if (!manager || !job) {
              ctx.ui.notify(
                words[1]
                  ? `No workflow with id ${words[1]}. Try /workflows for the list.`
                  : "Name a run: /workflows retry <id>",
                "warning",
              );
              return;
            }
            const outcome = await retryFailedOne(job.id);
            ctx.ui.notify(retryFailedNotice(outcome), outcome.ok ? "info" : "warning");
            return;
          }

          // `/workflows rerun <id> <phase>`: run every agent of a phase again.
          if (words[0] === "rerun") {
            if (!manager) {
              ctx.ui.notify(
                words[1]
                  ? `No workflow with id ${words[1]}. Try /workflows for the list.`
                  : "Name a run: /workflows rerun <id> <phase>",
                "warning",
              );
              return;
            }
            const job = words[1] ? manager.get(words[1]) : undefined;
            if (!job) {
              ctx.ui.notify(
                words[1] ? `No workflow with id ${words[1]}. Try /workflows for the list.` : "Name a run: /workflows rerun <id> <phase>",
                "warning",
              );
              return;
            }
            // A phase name can have spaces, so the rest of the line is the name.
            const outcome = await rerunPhaseOne(job.id, words.slice(2).join(" "));
            ctx.ui.notify(phaseRerunNotice(outcome), outcome.ok ? "info" : "warning");
            return;
          }

          // `/workflows stop` (all) or `/workflows stop <id>`.
          if (words[0] === "stop") {
            if (!manager) {
              ctx.ui.notify(
                words[1] ? `No workflow with id ${words[1]} in this session.` : "No workflow is running.",
                "info",
              );
              return;
            }
            const target = words[1];
            const jobs = target ? [manager.get(target)].filter((job): job is WorkflowJob => job !== undefined) : manager.active();
            if (jobs.length === 0) {
              ctx.ui.notify(target ? `No workflow with id ${target}.` : "No workflow is running.", "info");
              return;
            }
            // A third word names one agent, not the whole run: `/workflows stop
            // <id> alpha` saves the rest of the run. Without it, everything stops.
            const agentWord = words[2];
            if (agentWord) {
              const target = resolveStopTarget(jobs[0]!.live.values(), agentWord);
              if ("error" in target) {
                ctx.ui.notify(target.error, "warning");
                return;
              }
              const outcome = manager.stopAgent(jobs[0]!.id, target.id);
              if (!outcome.ok) {
                ctx.ui.notify(outcome.error ?? "that agent is not running any more", "warning");
                return;
              }
              const [job] = jobs;
              ctx.ui.notify(
                `Stopped ${target.id} in ${job!.id}. The rest of the run keeps going, and the tokens that agent had already spent stay on the bill.`,
                "warning",
              );
              return;
            }
            const stopped = jobs.filter((job) => manager.cancel(job.id)).map((job) => job.id);
            ctx.ui.notify(`Stopped ${stopped.join(", ")}.`, "warning");
            return;
          }

          // `/workflows <id>`: one job in detail.
          if (words[0] && manager) {
            const job = manager.get(words[0]!);
            if (!job) {
              ctx.ui.notify(`No workflow with id ${words[0]}. Try /workflows for the list.`, "warning");
              return;
            }
            ctx.ui.notify(renderJobDetail(job), job.state === "failed" ? "warning" : "info");
            return;
          }

          // `/workflows`: the live list, or the last run when nothing is live.
          const active = manager?.active() ?? [];
          if (active.length > 0) {
            ctx.ui.notify(renderJobList(active, manager!.list()), "info");
            return;
          }
          if (manager) {
            const finished = manager.list();
            if (finished.length > 0) {
              ctx.ui.notify(renderJobList([], finished), finished[0]!.state === "failed" ? "warning" : "info");
              return;
            }
          }
          const last = getLastWorkflowRun();
          ctx.ui.notify(renderWorkflowDetail(last), last?.result.ok === false ? "warning" : "info");
        },
      });

      // Alt+W: the live panel. It reads the job manager and writes nothing, so
      // opening it is always safe, even with no run at all.
      if (typeof qronos.registerShortcut === "function") {
        qronos.registerShortcut("alt+w", {
          description: "Workflow panel",
          handler: async (ctx: ExtensionCommandContext | any) => {
            const manager = managerFor();
            const shown = await openWorkflowPanel(ctx, manager, (ctx as { theme?: unknown }).theme as never, {
              stopAgent: (jobId: string, agentId: string) => manager.stopAgent(jobId, agentId),
              saveScript: (jobId: string) => {
                const job = manager.get(jobId);
                if (!job) return undefined;
                try {
                  return saveWorkflowScript({ cwd: process.cwd(), name: job.name, script: job.script }).path;
                } catch {
                  return undefined;
                }
              },
            });
            if (shown) appendWorkflowNote(qronos, "Dynamic workflows dialog dismissed");
          },
        });
      }
    },
  };
}
