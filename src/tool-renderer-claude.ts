import { Container, Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";

/**
 * Custom tool renderer extension that styles tool execution exactly like Claude Code:
 * - A clean dot bullet (● in green for success, ● in red for error, dim ● for in-progress)
 * - Concise ToolName(target) header
 * - Elegant tree connector ('└') on the first line below the command
 * - Aligned 4-space indentation on subsequent lines with zero full-block colored backgrounds
 */
export function createClaudeToolRendererExtension(): InlineExtension {
  return {
    name: "qronos-claude-tool-renderer",
    factory(pi: ExtensionAPI) {
      pi.registerToolRenderer((toolName, _next) => {
        return {
          renderShell: "self", // Completely disables Box and full-width colored background fills
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
            const { name, target } = formatToolCall(toolName, context?.args);

            const isError = Boolean(result?.isError);
            const dot = isError ? theme.fg("error", "● ") : theme.fg("success", "● ");
            const title = theme.bold(theme.fg("text", name));
            const sub = target ? theme.fg("dim", `(${target})`) : "";
            container.addChild(new Text(`${dot}${title}${sub}`, 0, 0));

            // Extract and format result text with Claude Code "└" tree branch connector
            const textContent = extractResultText(result);
            if (textContent) {
              const rawLines = textContent.trim().split("\n");
              const maxLines = options?.expanded ? 100 : 8;
              const displayLines = rawLines.slice(0, maxLines);

              const formattedLines = displayLines
                .map((line: string, index: number) => {
                  // First line uses '  └ ', subsequent lines indent with '    ' (aligned under └ text)
                  const branch = index === 0 ? `  ${theme.fg("dim", "└")} ` : `    `;
                  if (line.startsWith("+")) return `${branch}${theme.fg("success", line)}`;
                  if (line.startsWith("-")) return `${branch}${theme.fg("error", line)}`;
                  return `${branch}${theme.fg("muted", line)}`;
                })
                .join("\n");

              container.addChild(new Text(`\n${formattedLines}`, 0, 0));

              if (rawLines.length > maxLines) {
                container.addChild(
                  new Text(
                    `\n    ${theme.fg("dim", `... (${rawLines.length - maxLines} more lines, ctrl+o to expand)`)}`,
                    0,
                    0,
                  ),
                );
              }
            } else if (!isError) {
              // Empty successful output still gets clean tree connector
              container.addChild(new Text(`\n  ${theme.fg("dim", "└")} ${theme.fg("muted", "Done")}`, 0, 0));
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
      return { name: "Bash", target: args?.command ? truncate(args.command, 55) : "" };
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
