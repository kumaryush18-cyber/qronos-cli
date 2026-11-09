import { Container, Text } from "@earendil-works/pi-tui";
import { getLanguageFromPath, highlightCode } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";

/**
 * Custom tool renderer extension that styles tool execution exactly like Claude Code:
 * - Single-line header: ● ToolName(target) with green ● on success, red ● on error, dim ● while running
 * - Tree branch connector: '  └ ' on the first line of output
 * - Clean 4-space aligned indentation on all subsequent lines
 * - Full syntax highlighting for code files and diffs (+ in green, - in red)
 * - User message prompt chevron '> ' prepended to user prompt blocks
 */
export function createClaudeToolRendererExtension(): InlineExtension {
  return {
    name: "qronos-claude-tool-renderer",
    factory(pi: ExtensionAPI) {
      // 1. Prepend Claude Code '> ' prompt chevron to user messages
      pi.registerMarkdownTransformer((markdown, context) => {
        if (context.messageType === "user") {
          const trimmed = markdown.trim();
          if (trimmed.startsWith("> ") || trimmed.startsWith("› ") || trimmed.startsWith("» ")) {
            return markdown;
          }
          return `> ${markdown}`;
        }
        return markdown;
      });

      // 2. Register Claude Code style tool renderers
      pi.registerToolRenderer((toolName, _next) => {
        return {
          renderShell: "self", // Disables Box container and full-width colored background fills

          // renderCall: ONLY renders the single header line: ● ToolName(target)
          renderCall(args: any, theme: any, context: any) {
            const container = new Container();
            const { name, target } = formatToolCall(toolName, args);

            // If command finished, update dot to green or red. While running, show dim.
            const isFinished = !context.isPartial && context.durationMs !== undefined;
            const isError = Boolean(context.isError);

            const dot = isFinished
              ? (isError ? theme.fg("error", "● ") : theme.fg("success", "● "))
              : theme.fg("dim", "● ");

            const title = theme.bold(theme.fg("text", name));
            const sub = target ? theme.fg("dim", `(${target})`) : "";
            container.addChild(new Text(`${dot}${title}${sub}`, 0, 0));
            return container;
          },

          // renderResult: ONLY renders the result output with '  └ ' branch connector.
          // DOES NOT re-print the header (prevents duplicate tool lines).
          renderResult(result: any, options: any, theme: any, context: any) {
            const container = new Container();
            const textContent = extractResultText(result);
            if (!textContent) {
              if (!result?.isError) {
                container.addChild(new Text(`  ${theme.fg("dim", "└")} ${theme.fg("muted", "Done")}`, 0, 0));
              }
              return container;
            }

            const rawLines = textContent.trimEnd().split("\n");
            // Remove leading empty lines
            while (rawLines.length > 0 && rawLines[0].trim() === "") {
              rawLines.shift();
            }

            if (rawLines.length === 0) {
              return container;
            }

            const maxLines = options?.expanded ? 120 : 8;
            const displayLines = rawLines.slice(0, maxLines);

            // Check if this output is code from a known file path
            const targetPath = context?.args?.file_path || context?.args?.path || "";
            const lang = targetPath ? getLanguageFromPath(targetPath) : undefined;

            let highlightedLines = displayLines;
            if (lang && toolName !== "bash") {
              try {
                highlightedLines = highlightCode(displayLines.join("\n"), lang);
              } catch {
                highlightedLines = displayLines;
              }
            }

            // Format with Claude Code '  └ ' branch on the first line and '    ' (4-space indent) on rest
            const formattedLines = highlightedLines
              .map((line: string, index: number) => {
                const branch = index === 0 ? `  ${theme.fg("dim", "└")} ` : `    `;
                if (line.startsWith("+")) return `${branch}${theme.fg("success", line)}`;
                if (line.startsWith("-")) return `${branch}${theme.fg("error", line)}`;
                return `${branch}${line}`;
              })
              .join("\n");

            container.addChild(new Text(`${formattedLines}`, 0, 0));

            if (rawLines.length > maxLines) {
              container.addChild(
                new Text(
                  `\n    ${theme.fg("dim", `... (${rawLines.length - maxLines} more lines, ctrl+o to expand)`)}`,
                  0,
                  0,
                ),
              );
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
