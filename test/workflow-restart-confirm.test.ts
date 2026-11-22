import { describe, expect, test } from "bun:test";
import {
  RESTART_ANSWERS,
  RestartConfirmPrompt,
  askRestartConfirm,
  buildRestartLines,
} from "../src/workflow-restart-confirm";

const plain = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, "");

const request = {
  label: "coding-agent",
  model: "claude-haiku-5.5",
  tokens: 4_300,
  prompt: "Read the parser and find the bug.",
};
const text = (overrides: Record<string, unknown> = {}) =>
  buildRestartLines({ request, selected: 2, width: 66, ...overrides })
    .map((line) => line.text)
    .join("\n");

describe("the restart card", () => {
  test("it asks the question in plain words", () => {
    expect(text()).toContain("Run this agent again?");
  });

  test("it names the agent, the model and what it cost last time", () => {
    const shown = text();
    expect(shown).toContain("coding-agent");
    expect(shown).toContain("claude-haiku-5.5");
    expect(shown).toContain("4300 tokens last time");
  });

  test("it shows the task that would be repeated", () => {
    expect(text()).toContain("Read the parser and find the bug.");
  });

  test("it says the cost out loud", () => {
    expect(text()).toContain("spends tokens again");
  });

  test("it promises that the rest of the run is safe", () => {
    expect(text()).toContain("the rest of the run is not touched");
  });

  test("the safe answer is the one the cursor starts on", () => {
    expect(text()).toContain("▸ 3. No");
  });

  test("all three answers are on the card, in order", () => {
    expect(RESTART_ANSWERS).toEqual(["yes", "edit", "no"]);
    const shown = text();
    expect(shown).toContain("1. Yes, run it again");
    expect(shown).toContain("2. Edit the task, then run it");
    expect(shown).toContain("3. No");
  });

  test("the cursor can move up to yes", () => {
    expect(text({ selected: 0 })).toContain("▸ 1. Yes, run it again");
  });

  test("an edited task is labelled, so a change is never invisible", () => {
    const shown = text({ draft: "Read the writer, not the parser." });
    expect(shown).toContain("Read the writer, not the parser.");
    expect(shown).toContain("edited, not the task it had before");
  });

  test("a changing task is not labelled when nothing changed", () => {
    expect(text({ draft: request.prompt })).not.toContain("edited, not");
  });

  test("a long task is cut, with the count of what is hidden", () => {
    const shown = text({ draft: "word ".repeat(200) });
    expect(shown).toContain("more line");
  });

  test("while editing, the keys are about the text", () => {
    const shown = text({ editing: true });
    expect(shown).toContain("ctrl+g editor");
    expect(shown).toContain("enter run it");
  });
});

function prompt(extras: { edit?: (text: string) => string | undefined } = {}) {
  const answers: Array<{ approved: boolean; prompt?: string }> = [];
  const component = new RestartConfirmPrompt({
    request,
    theme: { fg: (_slot: string, value: string) => value } as never,
    done: (outcome) => answers.push(outcome),
    ...extras,
  });
  return { component, answers };
}

describe("the restart prompt", () => {
  test("it draws a bordered card of the width it is given", () => {
    const { component } = prompt();
    const lines = component.render(58);
    expect(plain(lines[0]!)).toStartWith("╭");
    expect(plain(lines.at(-1)!)).toStartWith("╰");
    for (const line of lines) expect(plain(line).length).toBe(58);
  });

  test("esc means no", () => {
    const { component, answers } = prompt();
    component.handleInput("\u001b");
    expect(answers).toEqual([{ approved: false, prompt: undefined }]);
  });

  test("n means no, and 3 means no", () => {
    for (const key of ["n", "3"]) {
      const { component, answers } = prompt();
      component.handleInput(key);
      expect(answers).toEqual([{ approved: false, prompt: undefined }]);
    }
  });

  test("y means yes, and it repeats the same task", () => {
    const { component, answers } = prompt();
    component.handleInput("y");
    expect(answers).toEqual([{ approved: true, prompt: undefined }]);
  });

  test("enter takes the answer the cursor is on, which is no", () => {
    const { component, answers } = prompt();
    component.handleInput("\r");
    expect(answers).toEqual([{ approved: false, prompt: undefined }]);
  });

  test("enter after moving up to yes means yes", () => {
    const { component, answers } = prompt();
    component.handleInput("\u001b[A");
    component.handleInput("\u001b[A");
    component.handleInput("\r");
    expect(answers).toEqual([{ approved: true, prompt: undefined }]);
  });

  test("one step up from no is the edit answer, not yes", () => {
    const { component, answers } = prompt();
    component.handleInput("\u001b[A");
    component.handleInput("\r");
    expect(component.editing).toBe(true);
    expect(answers).toEqual([]);
  });

  test("the cursor stops at the top and at the bottom", () => {
    const { component } = prompt();
    for (let press = 0; press < 5; press += 1) component.handleInput("\u001b[A");
    expect(component.selected).toBe(0);
    for (let press = 0; press < 5; press += 1) component.handleInput("\u001b[B");
    expect(component.selected).toBe(2);
  });

  test("it answers once only", () => {
    const { component, answers } = prompt();
    component.handleInput("\u001b");
    component.handleInput("y");
    expect(answers).toEqual([{ approved: false, prompt: undefined }]);
  });
});

describe("editing the task in the card", () => {
  test("2 opens the task with the words already there", () => {
    const { component } = prompt();
    component.handleInput("2");
    expect(component.editing).toBe(true);
    expect(component.draft).toBe(request.prompt!);
  });

  test("typing adds to the task, and enter runs the new words", () => {
    const { component, answers } = prompt();
    component.handleInput("2");
    component.handleInput(" Also check the writer.");
    component.handleInput("\r");
    expect(answers).toEqual([{ approved: true, prompt: `${request.prompt} Also check the writer.` }]);
  });

  test("backspace removes the last character", () => {
    const { component } = prompt();
    component.handleInput("2");
    component.handleInput("x");
    component.handleInput("\u007f");
    expect(component.draft).toBe(request.prompt!);
  });

  test("ctrl+g opens the editor and takes what it returns", () => {
    const { component, answers } = prompt({ edit: () => "Read the writer instead." });
    component.handleInput("2");
    component.handleInput("\u0007");
    expect(component.draft).toBe("Read the writer instead.");
    component.handleInput("\r");
    expect(answers).toEqual([{ approved: true, prompt: "Read the writer instead." }]);
  });

  test("a cancelled edit keeps the text it had", () => {
    const { component } = prompt({ edit: () => undefined });
    component.handleInput("2");
    component.handleInput("\u0007");
    expect(component.draft).toBe(request.prompt!);
  });

  test("esc leaves the text alone and goes back to the answers", () => {
    const { component, answers } = prompt();
    component.handleInput("2");
    component.handleInput(" Hello");
    component.handleInput("\u001b");
    expect(component.editing).toBe(false);
    expect(answers).toEqual([]);
    // A second esc is the decision, and it is "no".
    component.handleInput("\u001b");
    expect(answers).toEqual([{ approved: false, prompt: undefined }]);
  });

  test("editing and then deleting everything runs the task it had", () => {
    const { component, answers } = prompt();
    component.handleInput("2");
    component.draft = "";
    component.handleInput("\r");
    expect(answers).toEqual([{ approved: true, prompt: undefined }]);
  });

  test("an identical edit is not sent as a new task", () => {
    const { component, answers } = prompt();
    component.handleInput("2");
    component.handleInput("   ");
    component.handleInput("\r");
    expect(answers).toEqual([{ approved: true, prompt: undefined }]);
  });
});

describe("asking with no terminal", () => {
  test("no overlay means no restart", async () => {
    expect(await askRestartConfirm(undefined, request)).toEqual({ approved: false });
  });

  test("the card the host builds is the one that answers", async () => {
    const outcome = await askRestartConfirm(
      {
        ui: {
          custom: async (build: any) => {
            const component = build({ requestRender: () => {} }, { fg: (_s: string, t: string) => t }, {}, () => {});
            component.handleInput("y");
          },
        },
      },
      request,
    );
    expect(outcome).toEqual({ approved: true, prompt: undefined });
  });

  test("closing the card without choosing means no", async () => {
    expect(await askRestartConfirm({ ui: { custom: async () => undefined } }, request)).toEqual({ approved: false });
  });
});
