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
import { RUNNING, cross, formatDuration, formatTokens, pad, phaseMark, replayMark, tick, tokenBar } from "./workflow-glyphs";
import { WorkflowJobManager, type WorkflowJob } from "./workflow-jobs";
import { journalDir, journalPath, pruneJournals } from "./workflow-journal";
import { openWorkflowPanel } from "./workflow-panel";
import { saveWorkflowScript } from "./workflow-save";
import { approvalRequestFor, askWorkflowApproval } from "./workflow-approval";
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
  },
  required: ["script"],
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
    const mark = agent.replayed ? replayMark() : agent.ok ? tick() : cross();
    const depth = agent.depth > 1 ? "  ".repeat(agent.depth - 1) + "└ " : "";
    const label = agent.label.length > nameWidth ? `${agent.label.slice(0, nameWidth - 1)}…` : agent.label;
    const tokens = formatTokens(agent.usage?.total ?? 0).padStart(6);
    const bar = tokenBar(agent.usage?.total ?? 0, maxTokens, 8);
    const time = formatDuration(agent.durationMs).padStart(6);
    const why = agent.error ? `  ${agent.error}` : "";
    return `  ${mark} ${pad(depth + label, nameWidth + 4)} ${bar} ${tokens} ${time}${why}`;
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
    lines.push("", "/workflows <id> for detail · /workflows stop <id> to stop");
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
  const result = job.result ?? resultFromJob(job);
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
  const failed = result.agents.filter((agent) => !agent.ok).length;
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

export function createWorkflowToolExtension(options: CreateWorkflowToolOptions = {}): InlineExtension {
  const runner = options.runner ?? defaultSubagentRunner;
  const registry = options.registry ?? new AgentRegistry();
  const config = options.config ?? workflowConfigFromEnv();
  const userHome = options.userHomeDir ?? homedir();
  const now = options.now ?? Date.now;

  return {
    name: "qronos-workflow",
    factory(qronos: ExtensionAPI) {
      /** One subagent, mapped onto the workflow result shape. */
      const runAgentOnce = async (
        request: Parameters<WorkflowAgentRunner>[0],
        signal: AbortSignal,
        ctx: ExtensionToolContext,
      ): Promise<WorkflowAgentResult> => {
        if (signal.aborted) return { ok: false, text: "", error: "stopped" };
        const base: AgentDefinition = { ...BUILTIN_AGENTS["general-purpose"]!, source: "builtin" };
        const definition: AgentDefinition = request.agentType ? { ...base, name: request.agentType } : base;
        try {
          const outcome = await runner({
            agentDef: definition,
            prompt: request.prompt,
            description: request.label ?? "workflow task",
            cwd: ctx.cwd || process.cwd(),
            ctx,
            outputSchema: request.schema,
            model: request.model,
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
          if (outcome.structured) {
            return { ok: true, text: outcome.output, data: outcome.structured.value, usage };
          }
          if (outcome.schemaIssues && outcome.schemaIssues.length > 0) {
            return {
              ok: false,
              text: outcome.output,
              usage,
              error: `schema not satisfied: ${outcome.schemaIssues
                .slice(0, 3)
                .map((issue) => `${issue.path || "value"} ${issue.message}`)
                .join("; ")}`,
            };
          }
          return { ok: true, text: outcome.output, usage };
        } catch (error) {
          return { ok: false, text: "", error: error instanceof Error ? error.message : String(error) };
        }
      };

      // The job manager is per extension instance, so the journals, the status
      // line and the "one report per job" rule all belong to this session.
      const state: WorkflowSessionState = { lastStatusAt: 0 };
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
          const script = typeof params?.script === "string" ? params.script : "";
          const name = (typeof params?.name === "string" && params.name.trim() !== "" ? params.name : "workflow").slice(0, 60);
          const resumeFrom = typeof params?.resumeFrom === "string" ? params.resumeFrom.trim() : "";
          if (script.trim() === "" && resumeFrom === "") {
            return {
              content: [{ type: "text" as const, text: "Error: the workflow needs a script (or a resumeFrom id)." }],
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
            `/workflows stop ${job.id}  stop it`,
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
            await openWorkflowPanel(ctx, managerFor(), (ctx as { theme?: unknown }).theme as never, { saveScript });
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
            await openWorkflowPanel(ctx, manager, (ctx as { theme?: unknown }).theme as never, {
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
          },
        });
      }
    },
  };
}
