// #28 R20a: defense-in-depth. free-pi-cli's closed extension list (see
// pi-launch.ts's buildRuntimeOptions) and the SDK's strict `tools` allowlist
// are the real reasons no subagent-shaped tool ever reaches the model
// (SB1). This extension is the belt to that braces: if a tool outside the
// allowed set is ever presented anyway — only reachable if a user has
// hand-placed a file in their own local extensions directory (see the
// plan's Gap Analysis; not a server-side hole) — block it rather than
// execute it, and report the occurrence. A real report is a should-never-
// fire, high-signal event, never a normal one.
import type { ExtensionAPI, InlineExtension, ToolCallEventResult } from "@earendil-works/pi-coding-agent";

export interface CreateToolGuardOptions {
  baseUrl: string;
  /** Reads the current JWT from the cli's credential store. May be async. */
  getToken: () => string | Promise<string>;
  /** The full set of tool names this distro ever legitimately calls. */
  allowedTools: readonly string[];
  fetchImpl?: typeof fetch;
}

/** Best-effort POST /telemetry/tool-guard — never throws, never blocks the tool_call handler. */
async function reportToolGuardTrigger(opts: CreateToolGuardOptions, toolName: string): Promise<void> {
  try {
    const token = await opts.getToken();
    const doFetch = opts.fetchImpl ?? fetch;
    await doFetch(`${opts.baseUrl}/telemetry/tool-guard`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ tool_name: toolName }),
      signal: AbortSignal.timeout(3_000),
    });
  } catch {
    // best-effort; a reporting failure must never surface to the user
  }
}

// MCP tools come from servers the user configured: `mcp__<server>__<tool>`,
// plus the three resource tools pi adds when a server has resources.
const MCP_RESOURCE_TOOLS = ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"];

const DESTRUCTIVE_COMMAND_PATTERNS = [
  /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f?|-[a-zA-Z]*f[a-zA-Z]*r?)\s+/i, // rm -rf, rm -r
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+(-[a-zA-Z]*f)/i,
  /\bgit\s+push\s+.*(--force|-f)\b/i,
  /\b(drop\s+database|drop\s+table|truncate\s+table)\b/i,
  /\b(prisma\s+migrate\s+reset|drizzle-kit\s+drop)\b/i,
  /\b(mkfs|dd\s+if=)\b/i,
  /\bchmod\s+(-[a-zA-Z]*R\s+)?777\s+\//i,
];

export function isDestructiveCommand(cmd: string): boolean {
  if (!cmd) return false;
  return DESTRUCTIVE_COMMAND_PATTERNS.some((pattern) => pattern.test(cmd));
}

function isAllowed(opts: CreateToolGuardOptions, name: string): boolean {
  return opts.allowedTools.includes(name) || name.startsWith("mcp__") || MCP_RESOURCE_TOOLS.includes(name);
}

export function createToolGuardExtension(opts: CreateToolGuardOptions): InlineExtension {
  return {
    name: "qronos-tool-guard",
    factory(pi: ExtensionAPI) {
      pi.on("tool_call", async (event, ctx): Promise<ToolCallEventResult | undefined> => {
        if (!isAllowed(opts, event.toolName)) {
          void reportToolGuardTrigger(opts, event.toolName);
          return { block: true, reason: "tool not permitted in the Qronos distro" };
        }

        // Destructive command safety confirmation gate
        if (event.toolName === "bash") {
          const cmd = (event.input as any)?.command || "";
          if (isDestructiveCommand(cmd)) {
            const confirmed = await ctx.ui.confirm(
              "⚠️ Destructive Command Detected",
              `The agent wants to execute a potentially destructive command:\n\n  ${cmd}\n\nDo you want to proceed?`
            );
            if (!confirmed) {
              return {
                block: true,
                reason: `Command execution cancelled by user for safety: "${cmd}"`,
              };
            }
          }
        }

        return undefined;
      });
    },
  };
}
