import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createClaudeToolRendererExtension } from "../src/tool-renderer-claude";

const theme = {
  fg: (_role: string, text: string) => text,
  bold: (text: string) => text,
};

/** Run the extension's renderer resolver and render one tool call. */
function renderCall(toolName: string, args: Record<string, unknown>, width = 80): string[] {
  // The renderer truncates to the terminal width, exactly as it does in a real
  // session, so the test has to pretend to be that terminal. `columns` is not a
  // plain property on a non-tty stdout, hence defineProperty.
  const before = process.stdout.columns;
  Object.defineProperty(process.stdout, "columns", { value: width, configurable: true });
  try {
    let resolver: ((name: string, next: () => undefined) => any) | undefined;
    const pi = {
      registerMarkdownTransformer: () => {},
      registerToolRenderer: (r: any) => {
        resolver = r;
      },
    };
    (createClaudeToolRendererExtension() as { factory: (p: never) => void }).factory(pi as never);
    const renderers = resolver!(toolName, () => undefined);
    const component = renderers.renderCall(args, theme, {
      isPartial: false,
      durationMs: 1200,
      isError: false,
      args,
    });
    return component.render(width);
  } finally {
    if (before === undefined) delete (process.stdout as { columns?: number }).columns;
    else Object.defineProperty(process.stdout, "columns", { value: before, configurable: true });
  }
}

function withFlag<T>(value: string | undefined, run: () => T): T {
  const before = process.env.QRONOS_TOOL_DESCRIPTIONS;
  if (value === undefined) delete process.env.QRONOS_TOOL_DESCRIPTIONS;
  else process.env.QRONOS_TOOL_DESCRIPTIONS = value;
  try {
    return run();
  } finally {
    if (before === undefined) delete process.env.QRONOS_TOOL_DESCRIPTIONS;
    else process.env.QRONOS_TOOL_DESCRIPTIONS = before;
  }
}

describe("bash call with a step name", () => {
  test("draws the sentence, then the command", () => {
    const lines = withFlag(undefined, () =>
      renderCall("bash", { command: "git status", description: "Show working tree status" }),
    );
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("Show working tree status");
    expect(lines[1]).toContain("$ git status");
  });

  test("the finished dot keeps its tick colour, the words stay readable", () => {
    const lines = renderCall("bash", { command: "ls", description: "List files" });
    expect(lines[0]!.startsWith("● ")).toBe(true);
    expect(lines[0]).toContain("List files");
  });

  test("a multi-line command shows its first line only", () => {
    const lines = renderCall("bash", {
      command: "cat > sweep.py <<'EOF'\nimport json\nEOF",
      description: "Write the probe script",
    });
    expect(lines[1]).toContain("cat > sweep.py <<'EOF'");
    expect(lines.join("\n")).not.toContain("import json");
  });

  test("a long sentence and a long command both fit the width", () => {
    for (const width of [40, 60, 74, 120]) {
      const lines = renderCall(
        "bash",
        { command: `echo ${"x".repeat(300)}`, description: `Run ${"y".repeat(300)}` },
        width,
      );
      // The renderer emits colour resets, so measure visible cells, not bytes.
      for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });

  test("powershell uses its own prompt", () => {
    const lines = renderCall("powershell", { command: "Get-ChildItem", description: "List the folder" });
    expect(lines[1]).toContain("PS> Get-ChildItem");
  });
});

describe("fallbacks", () => {
  test("no description keeps the old one-line Bash(cmd) header", () => {
    const lines = renderCall("bash", { command: "git status" });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Bash(git status)");
  });

  test("QRONOS_TOOL_DESCRIPTIONS=0 hides the step line", () => {
    const lines = withFlag("0", () =>
      renderCall("bash", { command: "git status", description: "Show working tree status" }),
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Bash(git status)");
  });

  test("a description on a non-shell tool changes nothing", () => {
    const lines = renderCall("read", { path: "src/index.ts", description: "Read the entry point" });
    expect(lines).toHaveLength(1);
    // The path is wrapped in an OSC file link and uses the platform's
    // separator (src\index.ts on Windows), so match the visible words only.
    expect(lines[0]).toContain("Read(");
    expect(lines[0]).toContain("index.ts");
    expect(lines[0]).toContain("src");
    expect(lines[0]).not.toContain("Read the entry point");
  });
});
