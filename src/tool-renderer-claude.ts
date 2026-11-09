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
 * - Automatic dedenting so nested code snippets are not pushed excessively to the right
 * - Line lengths strictly bounded to terminal width to prevent mobile soft-wrapping to column 0
 * - Full syntax highlighting for code files and diffs (+ in green, - in red)
 * - User message prompt with literal upright '> ' (not slanted/italic)
 * - Clean borderless editor input without distracting horizontal black lines
 * - Clear spacing separating headings and sections in assistant responses
 */
export function createClaudeToolRendererExtension(): InlineExtension {
  return {
    name: "qronos-claude-tool-renderer",
    factory(pi: ExtensionAPI) {
      // 1. Markdown transformer: format prompt chevrons and ensure headings/sections are separated
      pi.registerMarkdownTransformer((markdown, context) => {
        if (context.messageType === "user") {
          const trimmed = markdown.trim();
          if (trimmed.startsWith("> ") || trimmed.startsWith("​> ") || trimmed.startsWith("› ")) {
            return trimmed;
          }
          return `​> ${trimmed}`;
        }

        if (context.messageType === "assistant") {
          let text = markdown;
          // Ensure markdown headings (# Heading) have proper separation
          text = text.replace(/([^\n])\n(#{1,6}\s+[^\n]+)/g, "$1\n\n$2");
          text = text.replace(/(#{1,6}\s+[^\n]+)\n([^\n#])/g, "$1\n\n$2");

          // Ensure bold section titles (**Title:**) have proper separation
          text = text.replace(/([^\n])\n(\*\*[^*]+:\*\*)\n?([^\n*])/g, "$1\n\n$2\n\n$3");
          return text;
        }

        return markdown;
      });

      // 3. Register Claude Code style tool renderers
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
            // Dedent lines so deeply nested code snippets aren't pushed far to the right
            const dedented = dedentLines(rawLines);
            const displayLines = dedented.slice(0, maxLines);

            // Syntax highlighting: detect language from file path, command string, or code structure
            const lang = detectLanguage(toolName, context?.args, textContent);
            const rawTarget = context?.args?.file_path || context?.args?.path || "";
            const targetFile = rawTarget ? relative(cwd, rawTarget) : "";

            let highlightedLines = displayLines;
            if (lang) {
              try {
                highlightedLines = highlightCode(displayLines.join("\n"), lang);
              } catch {
                highlightedLines = displayLines;
              }
            }

            // Summary line for read/write/edit if available
            let summaryPrefix = "";
            if (toolName === "write" && targetFile) {
              summaryPrefix = `Wrote ${rawLines.length} lines to ${targetFile}`;
            } else if (toolName === "read" && targetFile) {
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
                if (!lang && line.startsWith("+")) {
                  linesToDraw.push(`${branch}${theme.fg("success", line)}`);
                } else if (!lang && line.startsWith("-")) {
                  linesToDraw.push(`${branch}${theme.fg("error", line)}`);
                } else {
                  linesToDraw.push(`${branch}${line}`);
                }
              });
            }

            if (rawLines.length > maxLines) {
              linesToDraw.push(`    ${theme.fg("dim", `... (${rawLines.length - maxLines} more lines, ctrl+o to expand)`)}`);
            }

            // Strictly truncate every single line so narrow mobile screens never wrap to column 0,
            // with a blank separator line below so assistant responses have clear spacing
            const safeOutput = linesToDraw.map((l) => truncateToWidth(l, termWidth - 1)).join("\n") + "\n";
            container.addChild(new Text(safeOutput, 0, 0));

            return container;
          },
        };
      });
    },
  };
}

function dedentLines(lines: string[]): string[] {
  const nonEmpty = lines.filter((l) => l.trim().length > 0);
  if (nonEmpty.length === 0) return lines;
  const minIndent = Math.min(
    ...nonEmpty.map((l) => {
      const m = l.match(/^[ \t]*/);
      return m ? m[0].length : 0;
    }),
  );
  if (minIndent === 0) return lines;
  return lines.map((l) => (l.length >= minIndent ? l.slice(minIndent) : l));
}

function detectLanguage(toolName: string, args: any, text: string): string | undefined {
  // 1. Direct path from args (read, write, edit, etc.)
  const rawTarget = args?.file_path || args?.path || "";
  if (rawTarget) {
    const lang = getLanguageFromPath(rawTarget);
    if (lang) return lang;
  }

  // 2. If tool is bash, check command for file extension (e.g. cat server/gateway.ts, sed ... script.py)
  if (toolName === "bash" && args?.command) {
    const fileMatch = String(args.command).match(
      /[\w./-]+\.(ts|tsx|js|jsx|json|py|rs|go|html|css|md|sh|bash|yml|yaml|sql|c|cpp|h|java|php)\b/i,
    );
    if (fileMatch) {
      const lang = getLanguageFromPath(fileMatch[0]);
      if (lang) return lang;
    }
  }

  // 3. Fallback: inspect the first few lines of text to detect common formats
  const firstFew = text.slice(0, 1000);
  if (/^\s*[{}\[\]]/.test(firstFew) && (firstFew.includes('":') || firstFew.includes("':"))) {
    return "json";
  }
  if (/^\s*(import\s|export\s|const\s|let\s|function\s|class\s|type\s|interface\s)/m.test(firstFew)) {
    return "typescript";
  }
  if (/^\s*(def\s|class\s.*:|from\s+\w+\s+import)/m.test(firstFew)) {
    return "python";
  }
  if (/^\s*<\?php/.test(firstFew)) {
    return "php";
  }
  if (/^\s*<!DOCTYPE\s+html|<\w+>[\s\S]*<\/\w+>/i.test(firstFew)) {
    return "html";
  }

  return undefined;
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
