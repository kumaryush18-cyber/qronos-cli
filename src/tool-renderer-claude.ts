import { Container, Text } from "@earendil-works/pi-tui";
import { getLanguageFromPath, highlightCode } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";

/**
 * How many lines a collapsed tool result shows before "ctrl+o to expand".
 *
 * Tight on purpose for bash: a collapsed command should be a glance, not a
 * wall. Write/Edit use their own (larger) values because a diff needs context.
 */
export const COLLAPSED_BASH_LINES = 5;

/**
 * Ceiling on lines rendered when expanded.
 *
 * "Unlimited" in intent: 2000 covers any real test run or build log. The cap
 * exists so a runaway command that prints 200k lines cannot freeze the TUI by
 * asking it to lay out 200k rows. Past this, the remainder is reported as a
 * count with a hint to toggle back.
 */
export const EXPANDED_SAFETY_MAX_LINES = 2000;

/**
 * The hint shown after a truncated block.
 *
 * When already expanded, "ctrl+o to expand" is a dead end; the useful action is
 * to collapse again. Naming whichever direction is actually available keeps the
 * hint honest.
 */
function truncationHint(remaining: number, expanded: boolean | undefined): string {
  const key = "ctrl+o";
  return expanded
    ? `... (${remaining} more lines hidden, ${key} to collapse)`
    : `... (${remaining} more lines, ${key} to expand)`;
}

/**
 * Custom tool renderer extension that styles tool execution exactly like Claude Code:
 * - Single-line header: ● ToolName(target) with dot strictly beside the name (no awkward wrapping)
 * - Tree branch connector: ' └ ' on the first line of output
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
    factory(qronos: ExtensionAPI) {
      // 1. Markdown transformer: format prompt chevrons and ensure headings/sections are separated
      qronos.registerMarkdownTransformer((markdown, context) => {
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
      qronos.registerToolRenderer((toolName, _next) => {
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
            // Target is normal readable text, not dim grey
            const sub = target ? theme.fg("text", `(${target})`) : "";

            const headerLine = `${dot}${title}${sub}`;
            container.addChild(new Text(truncateToWidth(headerLine, termWidth), 0, 0));
            return container;
          },

          // renderResult: ONLY renders the result output with ' └ ' branch connector.
          // NEVER re-prints the header line (fixes duplicate tool lines).
          renderResult(result: any, options: any, theme: any, context: any) {
            const container = new Container();
            const termWidth = process.stdout.columns || 80;
            const cwd = process.cwd();

            const textContent = extractResultText(result);
            if (!textContent) {
              if (!result?.isError) {
                container.addChild(new Text(`  ${theme.fg("dim", "└")} ${theme.fg("text", "Done")}`, 0, 0));
              }
              return container;
            }

            const rawLines = textContent.trimEnd().split("\n");
            while (rawLines.length > 0 && rawLines[0].trim() === "") {
              rawLines.shift();
            }

            if (rawLines.length === 0) {
              if (!result?.isError) {
                container.addChild(new Text(`  ${theme.fg("dim", "└")} ${theme.fg("text", "Done")}`, 0, 0));
              }
              return container;
            }

            const maxLines = options?.expanded ? EXPANDED_SAFETY_MAX_LINES : COLLAPSED_BASH_LINES;
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
                highlightedLines = highlightedLines.map((line: string) => enhanceCodeHighlighting(line, lang));
              } catch {
                highlightedLines = displayLines;
              }
            }

            const linesToDraw: string[] = [];
            const startLine = Number(context?.args?.offset || context?.args?.line || 1);

            // 1. Tool: Read (Claude Code behavior: do NOT dump code by default! Keep clean unless expanded with ctrl+o)
            if (toolName === "read") {
              const summaryLine = `Read ${rawLines.length} lines${!options?.expanded ? " (ctrl+o to expand)" : ""}`;
              linesToDraw.push(`  ${theme.fg("dim", "└")} ${theme.fg("text", summaryLine)}`);

              if (options?.expanded) {
                highlightedLines.forEach((line: string, index: number) => {
                  const lineNum = startLine + index;
                  const numPad = String(lineNum).padStart(4, " ");
                  linesToDraw.push(`    ${theme.fg("dim", numPad)}   ${line}`);
                });
                if (rawLines.length > maxLines) {
                  linesToDraw.push(
                    `    ${theme.fg("dim", truncationHint(rawLines.length - maxLines, options?.expanded))}`,
                  );
                }
              }
            }
            // 2. Tool: Write (Claude Code behavior: show actual code block written with line numbers & syntax colors!)
            else if (toolName === "write") {
              let fileContent = typeof context?.args?.content === "string" ? context.args.content : "";
              if (!fileContent && rawTarget) {
                try {
                  const absPath = rawTarget.startsWith("/") ? rawTarget : resolve(cwd, rawTarget);
                  if (existsSync(absPath)) {
                    fileContent = readFileSync(absPath, "utf-8");
                  }
                } catch {}
              }

              const contentLines = fileContent ? fileContent.replace(/\r\n/g, "\n").split("\n") : rawLines;
              const totalLines = contentLines.length;
              const sizeBytes = Buffer.byteLength(fileContent || textContent, "utf-8");
              const sizeKb = Math.max(1, Math.round(sizeBytes / 1024));

              const summaryLine = `Wrote ${totalLines} line${totalLines === 1 ? "" : "s"} to ${makeClickableFileLink(targetFile, rawTarget, cwd)}`;
              linesToDraw.push(`  ${theme.fg("dim", "└")} ${theme.fg("text", summaryLine)}`);

              const writeMaxLines = options?.expanded ? EXPANDED_SAFETY_MAX_LINES : 8;
              const displayWriteLines = contentLines.slice(0, writeMaxLines);

              let writeHighlighted = displayWriteLines;
              if (lang) {
                try {
                  writeHighlighted = highlightCode(displayWriteLines.join("\n"), lang);
                  writeHighlighted = writeHighlighted.map((line: string) => enhanceCodeHighlighting(line, lang));
                } catch {
                  writeHighlighted = displayWriteLines;
                }
              }

              writeHighlighted.forEach((line: string, index: number) => {
                const lineNum = 1 + index;
                const numPad = String(lineNum).padStart(3, " ");
                if (line.trim().length === 0) {
                  linesToDraw.push(`    ${theme.fg("dim", numPad)}`);
                } else {
                  linesToDraw.push(`    ${theme.fg("dim", numPad)} ${line}`);
                }
              });

              if (totalLines > writeMaxLines) {
                const remaining = totalLines - writeMaxLines;
                linesToDraw.push(`    ${theme.fg("dim", `... +${remaining} lines (~${sizeKb} KB) ${truncationHint(remaining, options?.expanded).replace(/^\.\.\. \(/, "(").replace(/^/, "")}`)}`);
              }
            }
            // 3. Tool: Edit / Update with diffs (Claude Code behavior: Added X lines, removed Y lines + diff view)
            else if (toolName === "edit") {
              const diffText = result?.details?.diff || (typeof result?.diff === "string" ? result.diff : "");
              if (diffText) {
                const diffLines = diffText.trimEnd().split("\n");
                let addCount = 0;
                let delCount = 0;
                for (const line of diffLines) {
                  if (line.startsWith("+")) addCount++;
                  else if (line.startsWith("-")) delCount++;
                }

                let summaryLine = "";
                if (addCount > 0 && delCount > 0) {
                  summaryLine = `Added ${addCount} line${addCount === 1 ? "" : "s"}, removed ${delCount} line${delCount === 1 ? "" : "s"}`;
                } else if (addCount > 0) {
                  summaryLine = `Added ${addCount} line${addCount === 1 ? "" : "s"}`;
                } else if (delCount > 0) {
                  summaryLine = `Removed ${delCount} line${delCount === 1 ? "" : "s"}`;
                } else {
                  summaryLine = `Updated ${makeClickableFileLink(targetFile, rawTarget, cwd)}`;
                }
                linesToDraw.push(`  ${theme.fg("dim", "└")} ${theme.fg("text", summaryLine)}`);

                const editMaxLines = options?.expanded ? EXPANDED_SAFETY_MAX_LINES : 12;
                const displayDiffLines = diffLines.slice(0, editMaxLines);

                for (const rawLine of displayDiffLines) {
                  const m = rawLine.match(/^([+-\s])(\s*\d*)\s?(.*)$/);
                  if (!m) {
                    linesToDraw.push(`    ${rawLine}`);
                    continue;
                  }
                  const prefix = m[1];
                  const lineNum = m[2].trim();
                  const content = m[3];
                  const numPad = String(lineNum).padStart(4, " ");

                  if (prefix === "-") {
                    linesToDraw.push(`    \x1b[48;2;112;26;26m\x1b[38;2;255;255;255m${numPad} -\x1b[39m   ${content}\x1b[0m`);
                  } else if (prefix === "+") {
                    linesToDraw.push(`    \x1b[48;2;20;75;35m\x1b[38;2;255;255;255m${numPad} +\x1b[39m   ${content}\x1b[0m`);
                  } else {
                    linesToDraw.push(`    ${theme.fg("dim", numPad)}     ${content}`);
                  }
                }

                if (diffLines.length > editMaxLines) {
                  const remaining = diffLines.length - editMaxLines;
                  linesToDraw.push(`    ${theme.fg("dim", `... +${remaining} lines (${options?.expanded ? "ctrl+o to collapse" : "ctrl+o to expand"})`)}`);
                }
              } else {
                const addCount = rawLines.filter((l) => l.startsWith("+")).length;
                const delCount = rawLines.filter((l) => l.startsWith("-")).length;
                const summaryLine = addCount > 0 || delCount > 0
                  ? `Added ${addCount} line${addCount === 1 ? "" : "s"}, removed ${delCount} line${delCount === 1 ? "" : "s"}`
                  : `Updated ${makeClickableFileLink(targetFile, rawTarget, cwd)}`;
                linesToDraw.push(`  ${theme.fg("dim", "└")} ${theme.fg("text", summaryLine)}`);

                highlightedLines.forEach((line: string, index: number) => {
                  const isDiffAdd = line.startsWith("+");
                  const isDiffDel = line.startsWith("-");
                  const lineNum = startLine + index;
                  const numPad = String(lineNum).padStart(4, " ");

                  if (isDiffDel) {
                    const clean = line.slice(1).replace(/^\s/, "");
                    linesToDraw.push(`    \x1b[48;2;112;26;26m\x1b[38;2;255;255;255m${numPad} -\x1b[39m   ${clean}\x1b[0m`);
                  } else if (isDiffAdd) {
                    const clean = line.slice(1).replace(/^\s/, "");
                    linesToDraw.push(`    \x1b[48;2;20;75;35m\x1b[38;2;255;255;255m${numPad} +\x1b[39m   ${clean}\x1b[0m`);
                  } else {
                    linesToDraw.push(`    ${theme.fg("dim", numPad)}   ${line}`);
                  }
                });

                if (rawLines.length > maxLines) {
                  linesToDraw.push(
                    `    ${theme.fg("dim", truncationHint(rawLines.length - maxLines, options?.expanded))}`,
                  );
                }
              }
            }
            // 4. Other tools (Bash, etc.)
            else {
              highlightedLines.forEach((line: string, index: number) => {
                const branch = index === 0 ? `  ${theme.fg("dim", "└")} ` : `    `;
                if (line.startsWith("+")) {
                  linesToDraw.push(`${branch}\x1b[38;2;63;185;80m${line}\x1b[39m`);
                } else if (line.startsWith("-")) {
                  linesToDraw.push(`${branch}\x1b[38;2;248;81;73m${line}\x1b[39m`);
                } else {
                  linesToDraw.push(`${branch}${line}`);
                }
              });

              if (rawLines.length > maxLines) {
                linesToDraw.push(
                  `    ${theme.fg("dim", truncationHint(rawLines.length - maxLines, options?.expanded))}`,
                );
              }
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

/**
 * Enhances code syntax coloring with vibrant Claude Code palette:
 * - Tags in vibrant coral red (\x1b[38;2;255;123;114m)
 * - Attributes in sky blue (\x1b[38;2;121;192;255m)
 * - Comments in muted slate (\x1b[38;2;139;148;158m)
 */
function enhanceCodeHighlighting(line: string, _lang?: string): string {
  let res = line;

  // Comments: lines starting with // or /* or *
  if (/^\s*(\/\/|\/\*|\*)/.test(res)) {
    return `\x1b[38;2;139;148;158m${res.replace(/\x1b\[[0-9;]*m/g, "")}\x1b[39m`;
  }

  // JSX / HTML Tags & Attributes
  if (/<[a-zA-Z0-9_\/.]/.test(res)) {
    res = res.replace(/\b([a-zA-Z0-9_-]+)=/g, "\x1b[38;2;121;192;255m$1\x1b[39m=");
    res = res.replace(/(<\/?)([a-zA-Z0-9_.-]+)/g, "$1\x1b[38;2;255;123;114m$2\x1b[39m");
    res = res.replace(/(<|>|\/>)/g, "\x1b[38;2;139;148;158m$1\x1b[39m");
  }

  return res;
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
      return "Update";
    default:
      return toolName.charAt(0).toUpperCase() + toolName.slice(1);
  }
}

function formatTarget(toolName: string, args: any, cwd: string, maxLen: number): string {
  if (!args) return "";
  let raw = "";
  let rawFilePath = "";
  if (toolName === "bash") {
    raw = args.command || "";
  } else if (toolName === "read" || toolName === "write" || toolName === "edit") {
    rawFilePath = args.file_path || args.path || "";
    raw = rawFilePath ? relative(cwd, rawFilePath) : "";
  } else if (toolName === "codemode") {
    const code = args.code || args.script || Object.values(args)[0] || "";
    if (typeof code === "string") {
      if (/registry\.npmjs|npm\s|pkgs\s*=|dependencies/i.test(code)) {
        raw = "npm dependency check";
      } else {
        const firstLine = code.split("\n")[0].trim().replace(/^const\s+/, "").slice(0, 40);
        raw = firstLine || "script";
      }
    } else {
      raw = "script";
    }
  } else {
    const val = Object.values(args)[0];
    raw = typeof val === "string" ? val : "";
  }
  const display = truncateMiddle(raw, maxLen);
  return rawFilePath ? makeClickableFileLink(display, rawFilePath, cwd) : display;
}

function makeClickableFileLink(displayPath: string, rawPath: string, cwd: string): string {
  if (!rawPath || !displayPath) return displayPath;
  const absPath = rawPath.startsWith("/") ? rawPath : resolve(cwd, rawPath);
  return `\x1b]8;;file://${absPath}\x07${displayPath}\x1b]8;;\x07`;
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
