// Agent discovery for Qronos CLI subagents.
//
// Discovers custom agent definitions from:
//   1. Project: <root>/.qronos/agents/*.md
//   2. User:    ~/.qronos/agents/*.md
//
// Also provides built-in Claude Code agent presets:
//   - "general-purpose": Multi-step research and codebase exploration
//   - "Explore": Fast read-only codebase scout
//   - "Plan": Software architect for implementation plans

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

export interface AgentDefinition {
  name: string;
  description: string;
  tools?: string[];
  /** Tools this definition forbids. Applied before `tools`, as documented. */
  disallowedTools?: string[];
  /**
   * "plan" (default) keeps the subagent read-only; "acceptEdits" lets it write
   * when the parent session is also writable. Never widens beyond the parent.
   */
  permissionMode?: "plan" | "acceptEdits";
  model?: string;
  systemPrompt: string;
  source: "builtin" | "project" | "user";
  filePath?: string;
}

/**
 * The only tools a subagent may ever hold (Option B: strictly read-only).
 *
 * Lives here rather than in agent-tool.ts so the sanitiser below can use it
 * without importing the runner, which would be a cycle. Every write-capable
 * tool is absent by construction, and `bash` is absent because a shell is not
 * read-only in any meaningful sense.
 */
export const SUBAGENT_READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "read",
  "read_file",
  "grep",
  "glob",
  "find",
  "list_dir",
  "ls",
  "web_search",
  "docs_lookup",
  "qronos_docs",
  "qronos_usage",
  "enter_plan_mode",
  "exit_plan_mode",
]);

/**
 * Drop any tool a definition asks for that is not read-only.
 *
 * Applied at parse time so a hostile or mistaken `.qronos/agents/*.md` cannot
 * carry `write`/`edit`/`bash` into the runtime at all. Returns undefined when
 * nothing survives, which callers read as "use the full read-only set".
 */
export function sanitizeAgentTools(tools: readonly string[] | undefined): string[] | undefined {
  if (!tools) return undefined;
  const safe = tools.filter((t) => SUBAGENT_READ_ONLY_TOOLS.has(t));
  return safe.length > 0 ? safe : undefined;
}

export const BUILTIN_AGENTS: Record<string, Omit<AgentDefinition, "source">> = {
  "general-purpose": {
    name: "general-purpose",
    description: "General-purpose agent for researching complex questions, searching code, and multi-step exploration.",
    tools: ["read", "read_file", "grep", "glob", "find", "list_dir", "ls", "web_search", "docs_lookup", "exit_plan_mode"],
    systemPrompt: [
      "You are a specialized subagent running within Qronos CLI.",
      "Your mission is to perform targeted research, analysis, and exploration on behalf of the main agent.",
      "You operate with read-only tools to safely inspect the codebase without mutating files.",
      "If your task requires proposing changes, formulate a detailed plan and call exit_plan_mode for user approval.",
      "Always provide clear, factual summaries with exact file paths and line numbers.",
    ].join("\n"),
  },
  Explore: {
    name: "Explore",
    description: "Fast read-only search agent for broad fan-out searches across files, directories, and naming conventions.",
    tools: ["read", "read_file", "grep", "glob", "find", "list_dir", "ls"],
    systemPrompt: [
      "You are an Explore subagent for fast, read-only codebase exploration.",
      "Locate files, trace symbols, and inspect excerpts quickly.",
      "Synthesize your findings concisely, highlighting relevant file paths and line ranges.",
    ].join("\n"),
  },
  Plan: {
    name: "Plan",
    description: "Software architect agent for designing implementation plans before editing code.",
    tools: ["read", "read_file", "grep", "glob", "find", "list_dir", "ls", "exit_plan_mode"],
    systemPrompt: [
      "You are a Plan subagent responsible for designing robust implementation strategies.",
      "Explore existing code, identify critical files, consider architectural trade-offs, and produce step-by-step plans.",
      "When ready, call exit_plan_mode with your plan so the user can review and approve it.",
    ].join("\n"),
  },
};

type AgentFrontmatter = Record<string, unknown> & {
  name?: unknown;
  description?: unknown;
  tools?: unknown;
  disallowedTools?: unknown;
  permissionMode?: unknown;
  model?: unknown;
};

/** Read a permissionMode field, defaulting to the read-only value. */
function parsePermissionMode(value: unknown): "plan" | "acceptEdits" | undefined {
  if (value === "acceptEdits") return "acceptEdits";
  // Unknown values fall back to read-only rather than being ignored, so a typo
  // can never silently grant write access.
  return value === undefined ? undefined : "plan";
}

function parseToolList(value: unknown): string[] | undefined {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const tools = raw
    .filter((t): t is string => typeof t === "string")
    .map((t) => t.trim())
    .filter(Boolean);
  return tools.length > 0 ? tools : undefined;
}

function loadAgentsFromDirectory(dir: string, source: "project" | "user"): AgentDefinition[] {
  const agents: AgentDefinition[] = [];
  if (!existsSync(dir)) return agents;

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return agents;
  }

  for (const name of entries) {
    if (!name.endsWith(".md")) continue;
    const filePath = join(dir, name);
    try {
      if (!statSync(filePath).isFile()) continue;
      const content = readFileSync(filePath, "utf-8");
      const { frontmatter, body } = parseFrontmatter<AgentFrontmatter>(content);

      const agentName = typeof frontmatter.name === "string" ? frontmatter.name.trim() : name.replace(/\.md$/, "");
      const description = typeof frontmatter.description === "string" ? frontmatter.description.trim() : "Custom agent";

      agents.push({
        name: agentName,
        description,
        // Sanitised at parse time: a definition cannot carry a non-read-only
        // tool past this line, regardless of what its frontmatter says.
        tools: sanitizeAgentTools(parseToolList(frontmatter.tools)),
        disallowedTools: parseToolList(frontmatter.disallowedTools),
        permissionMode: parsePermissionMode(frontmatter.permissionMode),
        model: typeof frontmatter.model === "string" ? frontmatter.model.trim() : undefined,
        systemPrompt: body.trim(),
        source,
        filePath,
      });
    } catch {
      continue;
    }
  }

  return agents;
}

/**
 * Discovers all available subagent definitions, with project-level definitions
 * overriding user-level and built-ins.
 */
export function discoverSubagents(projectRoot: string, userHomeDir: string): AgentDefinition[] {
  const map = new Map<string, AgentDefinition>();

  // 1. Built-ins
  for (const [key, def] of Object.entries(BUILTIN_AGENTS)) {
    map.set(key.toLowerCase(), { ...def, source: "builtin" });
  }

  // 2. User directory (~/.qronos/agents/*.md)
  const userDir = join(userHomeDir, ".qronos", "agents");
  for (const agent of loadAgentsFromDirectory(userDir, "user")) {
    map.set(agent.name.toLowerCase(), agent);
  }

  // 3. Project directory (<root>/.qronos/agents/*.md)
  const projectDir = join(projectRoot, ".qronos", "agents");
  for (const agent of loadAgentsFromDirectory(projectDir, "project")) {
    map.set(agent.name.toLowerCase(), agent);
  }

  return Array.from(map.values());
}

/** Resolve a specific agent by name/subagent_type. Defaults to "general-purpose". */
export function resolveSubagent(
  type: string | undefined,
  projectRoot: string,
  userHomeDir: string,
): AgentDefinition {
  const available = discoverSubagents(projectRoot, userHomeDir);
  const target = (type || "general-purpose").trim().toLowerCase();
  const matched = available.find((a) => a.name.toLowerCase() === target);
  if (matched) return matched;

  // Fallback to general-purpose
  return { ...BUILTIN_AGENTS["general-purpose"]!, source: "builtin" };
}
