import { Container, Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";

/**
 * Custom tool renderer extension that styles tool execution exactly like Claude Code:
 * - A clean dot bullet (● in green for success, ● in red for error, dim ● for in-progress)
 * - Concise ToolName(target) header
 * - Indented clean output with no solid background rectangles
 */
export function createClaudeToolRendererExtension(): InlineExtension {
  return {
    name: "qronos-claude-tool-renderer",
    factory(pi: ExtensionAPI) {
      pi.registerToolRenderer((toolName, _next) => {
        return {
          renderShell: "self", // Disables Box container and full-width background fills
          renderCall(args: any, theme: any, _context: any) {
            const container = new Container();
            const { name, target } = formatToolCall(toolName, args);
            const dot = theme.fg("dim", "● ");
            const title = theme.bold(theme.fg("text", name));
            const sub = target ? theme.fg("dim", `(${target})`) : "";
            container.addChild(new Text(`${dot}${title}${sub}`, 0, 0));
            return container;
          },
          renderResult(result: any, options: any, theme: any, context: any) {
            const container = new Container();
            const { name, target } = formatToolCall(toolName, context.args);

            const isError = Boolean(result.isError);
            const dot = isError ? theme.fg("error", "● ") : theme.fg("success", "● ");
            const title = theme.bold(theme.fg("text", name));
            const sub = target ? theme.fg("dim", `(${target})`) : "";
            container.addChild(new Text(`${dot}${title}${sub}`, 0, 0));

            // Clean output rendering with subtle indentation and zero solid background blocks
            const textContent = extractResultText(result);
            if (textContent) {
              const lines = textContent.trim().split("\n");
              const maxLines = options?.expanded ? 100 : 6;
              const displayLines = lines.slice(0, maxLines);

              const formattedLines = displayLines
                .map((line: string) => {
                  if (line.startsWith("+")) return `  ${theme.fg("success", line)}`;
                  if (line.startsWith("-")) return `  ${theme.fg("error", line)}`;
                  return `  ${theme.fg("muted", line)}`;
                })
                .join("\n");

              container.addChild(new Text(`\n${formattedLines}`, 0, 0));

              if (lines.length > maxLines) {
                container.addChild(
                  new Text(`\n  ${theme.fg("dim", `... (${lines.length - maxLines} more lines)`)}`, 0, 0),
                );
              }
            }

            return container;
          },
        };
      });
    },
  };
}

function formatToolCall(toolName: string, args: any): { name: string; target: string } {
  switch (toolName) {
    case "bash":
      return { name: "Bash", target: args?.command ? truncate(args.command, 45) : "" };
    case "read":
      return { name: "Read", target: args?.file_path || args?.path || "" };
    case "write":
      return { name: "Write", target: args?.file_path || args?.path || "" };
    case "edit":
      return { name: "Edit", target: args?.file_path || args?.path || "" };
    default: {
      const formatted = toolName.charAt(0).toUpperCase() + toolName.slice(1);
      const firstArg = args ? Object.values(args)[0] : "";
      return { name: formatted, target: typeof firstArg === "string" ? truncate(firstArg, 35) : "" };
    }
  }
}

function extractResultText(result: any): string {
  if (!result) return "";
  if (typeof result === "string") return result;
  if (result.content && Array.isArray(result.content)) {
    return result.content
      .map((c: any) => (typeof c === "string" ? c : c.text || ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}
