// Agent tool — Task-scoped subagent execution for Qronos CLI.
//
// Matches Claude Code's `Agent` tool:
//   - Delegated execution with an isolated context window (no parent context pollution)
//   - Option B Enforcement: Subagents start strictly read-only and cannot mutate files
//     without explicit plan approval via `exit_plan_mode`.
//   - Recursion prevention: Subagents cannot call `agent` recursively.
//   - Specialized subagents: "general-purpose", "Explore", "Plan", or custom from `.qronos/agents/*.md`.

import type { ExtensionAPI, ExtensionToolContext, InlineExtension } from "@earendil-works/pi-coding-agent";
import type { Message, Model, Tool } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { homedir } from "node:os";
import { discoverSubagents, resolveSubagent, type AgentDefinition } from "./agent-discovery";

export const AGENT_TOOL_NAME = "agent";

export const SUBAGENT_READ_ONLY_TOOLS = new Set([
  "read",
  "read_file",
  "grep",
  "glob",
  "find",
  "list_dir",
  "ls",
  "web_search",
  "docs_lookup",
  "exit_plan_mode",
  "free_pi_docs",
  "free_pi_usage",
]);

export const SUBAGENT_MAX_TURNS = 10;

const PARAMS = Type.Object({
  description: Type.String({ description: "A short (3-5 word) description of the task" }),
  prompt: Type.String({ description: "The task for the agent to perform" }),
  subagent_type: Type.Optional(
    Type.String({
      description: "The type of specialized agent to use (e.g. general-purpose, Explore, Plan, or custom from .qronos/agents/*.md)",
    }),
  ),
  model: Type.Optional(Type.String({ description: "Optional model override for this agent" })),
});

const DESCRIPTION =
  "Launch a task-scoped subagent to handle complex, multi-step tasks with an isolated context window. Subagents run in read-only mode by default and must formulate a plan via exit_plan_mode for user approval before making any changes.";

export interface SubagentRunnerParams {
  agentDef: AgentDefinition;
  prompt: string;
  description: string;
  cwd: string;
  ctx: ExtensionToolContext;
  maxTurns?: number;
}

export interface SubagentTurnResult {
  output: string;
  turns: number;
  toolsUsed: string[];
  planApproved?: boolean;
}

export type SubagentRunner = (params: SubagentRunnerParams) => Promise<SubagentTurnResult>;

/**
 * In-process subagent execution loop.
 * Operates on an isolated message history to prevent context pollution of the parent session.
 */
export async function defaultSubagentRunner(params: SubagentRunnerParams): Promise<SubagentTurnResult> {
  const { agentDef, prompt, ctx, maxTurns = SUBAGENT_MAX_TURNS } = params;

  if (!ctx.model) {
    return {
      output: "Subagent execution unavailable: no active language model configured in this session.",
      turns: 0,
      toolsUsed: [],
    };
  }

  // Filter available tools to read-only tools and exit_plan_mode (excluding agent itself to prevent recursion)
  const allowedToolNames = new Set(
    (agentDef.tools && agentDef.tools.length > 0 ? agentDef.tools : Array.from(SUBAGENT_READ_ONLY_TOOLS)).filter(
      (t) => t !== AGENT_TOOL_NAME && t !== "subagent",
    ),
  );

  const subagentTools: Tool[] = [];
  const allTools: any[] = (ctx as any).getAllTools?.() || ctx.tools || [];
  for (const t of allTools) {
    if (allowedToolNames.has(t.name)) {
      subagentTools.push({
        name: t.name,
        description: t.description,
        parameters: t.parameters as any,
      });
    }
  }

  const systemPrompt = [
    agentDef.systemPrompt,
    "",
    "## Subagent Operating Rules (Option B Safety Policy):",
    "- You are executing as an isolated subagent.",
    "- You have READ-ONLY tools to explore, search, and inspect the codebase safely.",
    "- You cannot directly write or edit files. If modifications are required, you must formulate an implementation plan and call exit_plan_mode so the human user can review and approve it.",
    "- Synthesize your final answer clearly and concisely for the parent agent, citing relevant file paths and line numbers.",
  ].join("\n");

  const messages: Message[] = [
    {
      role: "user",
      content: [{ type: "text", text: prompt }],
      timestamp: Date.now(),
    },
  ];

  let turns = 0;
  const toolsUsed = new Set<string>();
  let finalOutput = "";
  let planApproved = false;

  while (turns < maxTurns) {
    turns++;
    let response: any;
    try {
      response = await completeSimple(
        ctx.model as Model<any>,
        {
          systemPrompt,
          messages,
          tools: subagentTools,
        },
        {
          signal: ctx.signal,
        },
      );
    } catch (err: any) {
      return {
        output: `Subagent encountered model completion error: ${err?.message || String(err)}`,
        turns,
        toolsUsed: Array.from(toolsUsed),
      };
    }

    messages.push(response);

    // Collect text from assistant response
    const textParts: string[] = [];
    const toolCalls: any[] = [];

    for (const part of response.content || []) {
      if (part.type === "text" && part.text) {
        textParts.push(part.text);
      } else if (part.type === "toolCall") {
        toolCalls.push(part);
      }
    }

    if (textParts.length > 0) {
      finalOutput = textParts.join("\n");
    }

    // If no tool calls were requested, the subagent has finished its task
    if (toolCalls.length === 0) {
      break;
    }

    // Execute requested tool calls with Option B enforcement
    for (const call of toolCalls) {
      const toolName = call.name;
      toolsUsed.add(toolName);

      // Check Option B permission
      if (!allowedToolNames.has(toolName)) {
        messages.push({
          role: "toolResult",
          toolCallId: call.id,
          toolName,
          content: [
            {
              type: "text",
              text: `Tool '${toolName}' is forbidden in subagent mode. Subagents operate with read-only tools. Propose your changes using exit_plan_mode for approval.`,
            },
          ],
          isError: true,
          timestamp: Date.now(),
        });
        continue;
      }

      // Execute tool via ExtensionToolContext
      try {
        const outcome = await ctx.executeTool(toolName, call.arguments);
        const toolResult = outcome.result;

        if (toolName === "exit_plan_mode" && (toolResult?.details as any)?.ok) {
          planApproved = true;
        }

        messages.push({
          role: "toolResult",
          toolCallId: call.id,
          toolName,
          content: toolResult?.content || [{ type: "text", text: String(toolResult || "done") }],
          isError: outcome.isError || toolResult?.isError || false,
          timestamp: Date.now(),
        });
      } catch (err: any) {
        messages.push({
          role: "toolResult",
          toolCallId: call.id,
          toolName,
          content: [{ type: "text", text: `Tool execution failed: ${err?.message || String(err)}` }],
          isError: true,
          timestamp: Date.now(),
        });
      }
    }
  }

  return {
    output: finalOutput || "Subagent finished task.",
    turns,
    toolsUsed: Array.from(toolsUsed),
    planApproved,
  };
}

export interface CreateAgentToolOptions {
  runner?: SubagentRunner;
  userHomeDir?: string;
}

export function createAgentToolExtension(opts: CreateAgentToolOptions = {}): InlineExtension {
  const runner = opts.runner ?? defaultSubagentRunner;
  const userHome = opts.userHomeDir ?? homedir();

  return {
    name: "qronos-agent",
    factory(pi: ExtensionAPI) {
      pi.registerTool({
        name: AGENT_TOOL_NAME,
        label: "Subagent",
        description: DESCRIPTION,
        promptSnippet:
          "Launch an isolated subagent for multi-step exploration or planning. Subagents start read-only and require plan approval for file edits.",
        parameters: PARAMS,
        async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<any> {
          const projectRoot = ctx.cwd || process.cwd();
          const agentDef = resolveSubagent(params.subagent_type, projectRoot, userHome);

          ctx.ui?.notify?.(`⚡ Running subagent [${agentDef.name}]: ${params.description}`, "info");

          const result = await runner({
            agentDef,
            prompt: params.prompt,
            description: params.description,
            cwd: projectRoot,
            ctx,
          });

          const summary = [
            `Subagent [${agentDef.name}] completed task: "${params.description}"`,
            `Turns: ${result.turns} | Tools used: ${result.toolsUsed.length > 0 ? result.toolsUsed.join(", ") : "none"}${result.planApproved ? " | Plan: Approved ✓" : ""}`,
            "",
            "--- Subagent Findings ---",
            result.output,
          ].join("\n");

          return {
            content: [{ type: "text" as const, text: summary }],
            details: {
              ok: true,
              agent: agentDef.name,
              turns: result.turns,
              toolsUsed: result.toolsUsed,
              planApproved: result.planApproved,
            },
          };
        },
      });
    },
  };
}
