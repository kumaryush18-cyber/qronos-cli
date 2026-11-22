import { describe, expect, test } from "bun:test";
import {
  TOOL_ANSWERS,
  WorkflowToolApprovalPrompt,
  askToolApproval,
  buildToolApprovalLines,
} from "../src/workflow-tool-approval";
import type { ToolFacts } from "../src/workflow-permissions";

const plain = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, "");

const shell: ToolFacts = {
  kind: "shell",
  command: "cd src && ls",
  insideProject: true,
  dangerous: false,
  summary: "run: cd src && ls",
};

const state = (overrides: Record<string, unknown> = {}) => ({
  request: { workflow: "analyze-src", facts: shell, asked: 1, total: 3 },
  selected: 0,
  width: 74,
  now: 0,
  ...overrides,
});

const text = (overrides: Record<string, unknown> = {}) => buildToolApprovalLines(state(overrides)).map((line) => line.text).join("\n");

describe("the tool card", () => {
  test("the heading names the tool, the run and the count", () => {
    const first = buildToolApprovalLines(state())[0]!;
    expect(first.text).toContain("Bash command");
    expect(first.text).toContain('from the "analyze-src" workflow');
    expect(first.text).toContain("1 of 3");
  });

  test("the command is shown as a command", () => {
    expect(text()).toContain("$ cd src && ls");
  });

  test("a write shows the path, not a command", () => {
    const write: ToolFacts = { kind: "write", path: "src/a.ts", insideProject: true, dangerous: false, summary: "write src/a.ts" };
    const lines = text({ request: { workflow: "w", facts: write, asked: 1, total: 1 } });
    expect(lines).toContain("src/a.ts");
    expect(lines).not.toContain("$ ");
  });

  test("four answers, in Claude Code's order", () => {
    expect(TOOL_ANSWERS).toEqual(["Yes", "yes-for-run", "yes-and-auto", "No"]);
    const lines = text();
    expect(lines).toContain("1. Yes");
    expect(lines).toContain("2. Yes, allow shell commands for this run");
    expect(lines).toContain("3. Yes, and switch to auto mode");
    expect(lines).toContain("4. No");
  });

  test("the cursor is on the first answer", () => {
    expect(text()).toContain("▸ 1. Yes");
  });

  test("the cursor moves", () => {
    expect(text({ selected: 2 })).toContain("▸ 3. Yes, and switch to auto mode");
  });

  test("a command with no total drops the denominator", () => {
    // A made-up denominator is worse than no denominator.
    const lines = text({ request: { workflow: "w", facts: shell, asked: 2, total: undefined } });
    expect(lines).not.toContain("2 of 2");
  });

  test("a destructive command says so", () => {
    const danger: ToolFacts = { kind: "shell", command: "rm -rf build", insideProject: true, dangerous: true, summary: "run: rm -rf build" };
    expect(text({ request: { workflow: "w", facts: danger, asked: 1, total: 1 } })).toContain("this command can destroy work");
  });

  test("a write outside the project says so", () => {
    const outside: ToolFacts = { kind: "write", path: "../x", insideProject: false, dangerous: true, summary: "write ../x" };
    expect(text({ request: { workflow: "w", facts: outside, asked: 1, total: 1 } })).toContain("outside the project");
  });

  test("the footer says nothing runs without a yes", () => {
    const lines = text();
    expect(lines).toContain("esc cancel");
    expect(lines).toContain("nothing runs unless you say yes");
  });

  test("a very long command is cut and marked", () => {
    const long: ToolFacts = { kind: "shell", command: "echo ".repeat(120), insideProject: true, dangerous: false, summary: "" };
    const lines = buildToolApprovalLines(state({ request: { workflow: "w", facts: long, asked: 1, total: 1 } }));
    expect(lines.filter((line) => line.style === "code").length).toBeLessThanOrEqual(3);
    expect(lines.map((line) => line.text).join("\n")).toContain("…");
  });

  test("a narrow card still draws", () => {
    const lines = buildToolApprovalLines(state({ width: 40 }));
    expect(lines.length).toBeGreaterThan(6);
  });
});

/** A prompt with a capture list, so the answer can be read back. */
function prompt() {
  const answers: string[] = [];
  const component = new WorkflowToolApprovalPrompt({
    request: { workflow: "analyze-src", facts: shell, asked: 1, total: 3 },
    theme: { fg: (_slot: string, text: string) => text } as never,
    done: (outcome) => answers.push(outcome.answer),
  });
  return { component, answers };
}

describe("the tool prompt", () => {
  test("it draws a bordered card the width it is given", () => {
    const { component } = prompt();
    const lines = component.render(60);
    expect(plain(lines[0]!)).toStartWith("╭");
    expect(plain(lines.at(-1)!)).toStartWith("╰");
    for (const line of lines) expect(plain(line).length).toBe(60);
  });

  test("escape answers No", () => {
    const { component, answers } = prompt();
    component.handleInput("\u001b");
    expect(answers).toEqual(["No"]);
  });

  test("enter answers with the selected option", () => {
    const { component, answers } = prompt();
    component.handleInput("\r");
    expect(answers).toEqual(["Yes"]);
  });

  test("1 to 4 pick an answer directly", () => {
    for (const [key, expected] of [
      ["1", "Yes"],
      ["2", "yes-for-run"],
      ["3", "yes-and-auto"],
      ["4", "No"],
    ] as const) {
      const { component, answers } = prompt();
      component.handleInput(key);
      expect(answers).toEqual([expected]);
    }
  });

  test("the arrows move the cursor and then enter picks it", () => {
    const { component, answers } = prompt();
    component.handleInput("\u001b[B");
    component.handleInput("\u001b[B");
    component.handleInput("\r");
    expect(answers).toEqual(["yes-and-auto"]);
  });

  test("the arrows stay inside the four answers", () => {
    const { component } = prompt();
    for (let index = 0; index < 10; index += 1) component.handleInput("\u001b[B");
    expect(component.selected).toBe(3);
    for (let index = 0; index < 10; index += 1) component.handleInput("\u001b[A");
    expect(component.selected).toBe(0);
  });

  test("it answers exactly once, however many keys arrive", () => {
    const { component, answers } = prompt();
    component.handleInput("\r");
    component.handleInput("\r");
    component.handleInput("\u001b");
    expect(answers).toEqual(["Yes"]);
  });

  test("an unknown key changes nothing", () => {
    const { component, answers } = prompt();
    component.handleInput("z");
    expect(answers).toEqual([]);
    expect(component.selected).toBe(0);
  });
});

describe("asking with no terminal", () => {
  test("it says skipped and answers No, never Yes", async () => {
    const answer = await askToolApproval(undefined, { workflow: "w", facts: shell, asked: 1 });
    expect(answer.answer).toBe("No");
    expect(answer.skipped).toBe(true);
  });

  test("the overlay is centred and reads the answer the prompt gave", async () => {
    const options: Record<string, unknown>[] = [];
    const answer = await askToolApproval(
      {
        ui: {
          custom: async (build: any, opts: any) => {
            options.push(opts);
            const component = build({ requestRender: () => {} }, { fg: (_s: string, t: string) => t }, {}, () => {});
            component.handleInput("2");
          },
        },
      },
      { workflow: "w", facts: shell, asked: 1 },
    );
    expect(answer.answer).toBe("yes-for-run");
    expect(options[0]?.overlay).toBe(true);
    expect((options[0]?.overlayOptions as { anchor?: string } | undefined)?.anchor).toBe("center");
  });

  test("closing the overlay without choosing means No", async () => {
    const answer = await askToolApproval(
      { ui: { custom: async () => undefined } },
      { workflow: "w", facts: shell, asked: 1 },
    );
    expect(answer.answer).toBe("No");
  });
});
