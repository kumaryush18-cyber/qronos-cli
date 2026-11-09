import { Container, Text } from "@earendil-works/pi-tui";
import { getLanguageFromPath, highlightCode } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { relative } from "node:path";
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";

/**
 * Custom tool renderer extension that styles tool execution exactly like Claude Code:
 * - Single-line header: ● ToolName(target) with dot strictly beside the name (no awkward wrapping)
 * - Tree branch connector: '  └ ' on the first line of output
 * - Clean 4-space aligned indentation on all subsequent lines
 * - Line lengths strictly bounded to terminal width to prevent mobile soft-wrapping to column 0
 * - Full syntax highlighting for code files and diffs (+ in green, - in red)
 * - User message prompt with literal upright '> ' (not slanted/italic)
 */
export function createClaudeToolRendererExtension(): InlineExtension {
  return {
    name: "qronos-claude-tool-renderer",
    factory(pi: ExtensionAPI) {
      // 1. Prepend literal upright '> ' to user messages (escaped so markdown won't italicize it)
      pi.registerMarkdownTransformer((markdown, context) => {
        if (context.messageType === "user") {
          const trimmed = markdown.trim();
          if (trimmed.startsWith("> ") || trimmed.startsWith("\\> ") || trimmed.startsWith("› ")) {
            return markdown;
          }
          return `\\> ${markdown}`;
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
            const termWidth = process.stdout.columns || 80;
            const cwd = process.cwd();

            const name = formatToolName(toolName);
            // Reserve space for dot (3 cells), parens (2 cells), and margins
            const maxTargetLen = Math.max(16, termWidth - name.length - 8);
            const target = formatTarget(toolName, args, cwd, maxTargetLen);

            // While running: dot is dim. When finished: green or red.
            const isFinished = !context.isPartial && context.durationMs !== undefined;
            const isError = Boolean(context.isError);

            const dot = isFinished
              ? (isError ? theme.fg("error", "● ") : theme.fg("success", "● "))
              : theme.fg("dim", "● ");

            const title = theme.bold(theme.fg("text", name));
            const sub = target ? theme.fg("dim", `(${target})`) : "";

            const headerLine = `${dot}${title}${sub}`;
            container.addChild(new Text(truncateToWidth(headerLine, termWidth), 0, 0));
            return container;
          },

          // renderResult: ONLY renders the result output with '  └ ' branch connector.
          // NEVER re-prints the header line (fixes duplicate tool lines).
          renderResult(result: any, options: any, theme: any, context: any) {
            const container = new Container();
            const termWidth = process.stdout.columns || 80;
            const cwd = process.cwd();

            const textContent = extractResultText(result);
            if (!textContent) {
              if (!result?.isError) {
                container.addChild(new Text(`  ${theme.fg("dim", "└")} ${theme.fg("muted", "Done")}`, 0, 0));
              }
              return container;
            }

            const rawLines = textContent.trimEnd().split("\n");
            while (rawLines.length > 0 && rawLines[0].trim() === "") {
              rawLines.shift();
            }

            if (rawLines.length === 0) {
              return container;
            }

            const maxLines = options?.expanded ? 120 : 8;
            const displayLines = rawLines.slice(0, maxLines);

            // Syntax highlighting for code files
            const rawTarget = context?.args?.file_path || context?.args?.path || "";
            const targetFile = rawTarget ? relative(cwd, rawTarget) : "";
            const lang = targetFile ? getLanguageFromPath(targetFile) : undefined;

            let highlightedLines = displayLines;
            if (lang && toolName !== "bash") {
              try {
                highlightedLines = highlightCode(displayLines.join("\n"), lang);
              } catch {
                highlightedLines = displayLines;
              }
            }

            // Summary line for read/write/edit if available
            let summaryPrefix = "";
            if (toolName === "write") {
              summaryPrefix = `Wrote ${rawLines.length} lines to ${targetFile}`;
            } else if (toolName === "read") {
              summaryPrefix = `Read ${rawLines.length} lines from ${targetFile}`;
            }

            const linesToDraw: string[] = [];
            if (summaryPrefix) {
              linesToDraw.push(`  ${theme.fg("dim", "└")} ${theme.fg("text", summaryPrefix)}`);
              for (const line of highlightedLines) {
                linesToDraw.push(`    ${line}`);
              }
            } else {
              highlightedLines.forEach((line: string, index: number) => {
                const branch = index === 0 ? `  ${theme.fg("dim", "└")} ` : `    `;
                if (line.startsWith("+")) {
                  linesToDraw.push(`${branch}${theme.fg("success", line)}`);
                } else if (line.startsWith("-")) {
                  linesToDraw.push(`${branch}${theme.fg("error", line)}`);
                } else {
                  linesToDraw.push(`${branch}${line}`);
                }
              });
            }

            if (rawLines.length > maxLines) {
              linesToDraw.push(`    ${theme.fg("dim", `... (${rawLines.length - maxLines} more lines, ctrl+o to expand)`)}`);
            }

            // Strictly truncate every single line so narrow mobile screens never wrap to column 0
            const safeOutput = linesToDraw.map((l) => truncateToWidth(l, termWidth - 1)).join("\n");
            container.addChild(new Text(safeOutput, 0, 0));

            return container;
          },
        };
      });
    },
  };
}

function formatToolName(toolName: string): string {
  switch (toolName) {
    case "bash":
      return "Bash";
    case "read":
      return "Read";
    case "write":
      return "Write";
    case "edit":
      return "Edit";
    default:
      return toolName.charAt(0).toUpperCase() + toolName.slice(1);
  }
}

function formatTarget(toolName: string, args: any, cwd: string, maxLen: number): string {
  if (!args) return "";
  let raw = "";
  if (toolName === "bash") {
    raw = args.command || "";
  } else if (toolName === "read" || toolName === "write" || toolName === "edit") {
    const p = args.file_path || args.path || "";
    raw = p ? relative(cwd, p) : "";
  } else {
    const val = Object.values(args)[0];
    raw = typeof val === "string" ? val : "";
  }
  return truncateMiddle(raw, maxLen);
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

function truncateMiddle(text: string, max: number): string {
  if (!text || text.length <= max) return text;
  const half = Math.floor((max - 3) / 2);
  return `${text.slice(0, half)}...${text.slice(-half)}`;
}
