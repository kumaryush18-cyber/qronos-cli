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
  workflowConfigFromEnv,
  type WorkflowConfig,
  type WorkflowEvent,
  type WorkflowRunResult,
} from "./workflow-types";

export const WORKFLOW_TOOL_NAME = "workflow";

const DESCRIPTION = [
  "Run a small JavaScript workflow that fans work out to subagents and returns one result.",
  "Only the returned value reaches the conversation, so this is how you touch many files without flooding it.",
  "Inside the script: agent(prompt, { label, schema }), parallel([...]), pipeline(list, fn), phase(name), log(message).",
  "No imports, no filesystem, no network. 10 minutes wall clock, 60 agents per run, 8 at a time.",
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

export function getLastWorkflowRun(): LastWorkflowRun | undefined {
  return lastRun;
}

export function resetLastWorkflowRun(): void {
  lastRun = undefined;
}

/** How the whole run is written into the chat. One report, no agent transcripts. */
export function renderWorkflowReport(name: string, result: WorkflowRunResult): string {
  const seconds = Math.max(1, Math.round(result.durationMs / 1000));
  const lines: string[] = [];
  const failed = result.agents.filter((agent) => !agent.ok).length;
  lines.push(`⚙ workflow ${name}: ${result.agents.length} agent${result.agents.length === 1 ? "" : "s"} in ${seconds}s`);
  if (result.phases.length > 0) lines.push(`phases: ${result.phases.join(" → ")}`);
  if (failed > 0) lines.push(`${failed} agent${failed === 1 ? "" : "s"} failed; the gaps are in the result`);
  if (result.truncated) lines.push("some output was dropped at the cap");

  if (!result.ok) {
    lines.push("", `failed: ${result.error ?? "unknown error"}`);
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

/** What `/workflows` prints: the last run, in detail. Pure, so it is testable. */
export function renderWorkflowDetail(run: LastWorkflowRun | undefined): string {
  if (!run) {
    return [
      "No workflow has run in this session.",
      "",
      "Start one by writing the word ultracode in a prompt, for example:",
      "  ultracode audit every route in src/routes for a missing auth check",
    ].join("\n");
  }
  const { result } = run;
  const seconds = Math.max(1, Math.round(result.durationMs / 1000));
  const lines = [
    `workflow: ${run.name}`,
    `state:   ${result.ok ? "finished" : "failed"}`,
    `agents:  ${result.agents.length} (${result.agents.filter((a) => !a.ok).length} failed)`,
    `time:    ${seconds}s`,
  ];
  if (result.phases.length > 0) lines.push(`phases:  ${result.phases.join(" → ")}`);
  if (result.error) lines.push(`error:   ${result.error}`);
  if (result.truncated) lines.push("note:    some output was dropped at the cap");
  for (const agent of result.agents) {
    lines.push(`  ${agent.ok ? "✓" : "✗"} ${agent.id} ${agent.label}${agent.error ? ` — ${agent.error}` : ""}`);
  }
  if (result.logs.length > 0) {
    lines.push("", "log:");
    lines.push(...result.logs.slice(-10));
  }
  return lines.join("\n");
}

export interface CreateWorkflowToolOptions {
  runner?: SubagentRunner;
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
          if (script.trim() === "") {
            return {
              content: [{ type: "text" as const, text: "Error: the workflow needs a script." }],
              details: { ok: false, reason: "no-script" },
            };
          }

          const projectRoot = ctx.cwd || process.cwd();
          const agentDef: AgentDefinition = { ...BUILTIN_AGENTS["general-purpose"]!, source: "builtin" };

          const runtime = new WorkflowRuntime({
            config,
            now,
            onEvent: options.onEvent,
            runAgent: async (request, signal) => {
              if (signal.aborted) return { ok: false, text: "", error: "stopped" };
              const definition: AgentDefinition = request.agentType
                ? { ...agentDef, name: request.agentType }
                : agentDef;
              try {
                const outcome = await runner({
                  agentDef: definition,
                  prompt: request.prompt,
                  description: request.label ?? "workflow task",
                  cwd: projectRoot,
                  ctx,
                  outputSchema: request.schema,
                });
                if (outcome.structured) {
                  return { ok: true, text: outcome.output, data: outcome.structured.value };
                }
                if (outcome.schemaIssues && outcome.schemaIssues.length > 0) {
                  return {
                    ok: false,
                    text: outcome.output,
                    error: `schema not satisfied: ${outcome.schemaIssues
                      .slice(0, 3)
                      .map((issue) => `${issue.path || "value"} ${issue.message}`)
                      .join("; ")}`,
                  };
                }
                return { ok: true, text: outcome.output };
              } catch (error) {
                return { ok: false, text: "", error: error instanceof Error ? error.message : String(error) };
              }
            },
          });

          // The Hub shows workflow agents too, so one roster stays true.
          void registry;
          void userHome;

          const result = await runtime.run(script);
          const runName = name !== "workflow" ? name : (result.meta.name ?? name);
          lastRun = { name: runName, result: { ...result }, at: now() };

          return {
            content: [{ type: "text" as const, text: renderWorkflowReport(runName, result) }],
            details: {
              ok: result.ok,
              name: runName,
              agents: result.agents.length,
              phases: result.phases,
              durationMs: result.durationMs,
              truncated: result.truncated,
              error: result.error ?? null,
            },
          };
        },
      });

      qronos.registerCommand("workflows", {
        description: "Show the last workflow: phases, agents and where it stopped",
        handler: async (_args: string, ctx: ExtensionCommandContext) => {
          const last = getLastWorkflowRun();
          ctx.ui.notify(renderWorkflowDetail(last), last?.result.ok === false ? "warning" : "info");
        },
      });
    },
  };
}
