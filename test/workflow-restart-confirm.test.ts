import { describe, expect, test } from "bun:test";
import {
  RestartConfirmPrompt,
  askRestartConfirm,
  buildRestartLines,
} from "../src/workflow-restart-confirm";

const plain = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, "");

const request = { label: "coding-agent", model: "claude-haiku-5.5", tokens: 4_300 };
const text = (overrides: Record<string, unknown> = {}) =>
  buildRestartLines({ request, selected: 1, width: 66, ...overrides })
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

  test("it says the cost out loud", () => {
    expect(text()).toContain("spends tokens again");
  });

  test("it promises that the rest of the run is safe", () => {
    expect(text()).toContain("the rest of the run is not touched");
  });

  test("the safe answer is the one the cursor starts on", () => {
    expect(text()).toContain("▸ 2. No");
  });

  test("the cursor can move up to yes", () => {
    expect(text({ selected: 0 })).toContain("▸ 1. Yes, run it again");
  });
});

function prompt() {
  const answers: boolean[] = [];
  const component = new RestartConfirmPrompt({
    request,
    theme: { fg: (_slot: string, value: string) => value } as never,
    done: (approved) => answers.push(approved),
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
    expect(answers).toEqual([false]);
  });

  test("n means no, and 2 means no", () => {
    for (const key of ["n", "2"]) {
      const { component, answers } = prompt();
      component.handleInput(key);
      expect(answers).toEqual([false]);
    }
  });

  test("y means yes", () => {
    const { component, answers } = prompt();
    component.handleInput("y");
    expect(answers).toEqual([true]);
  });

  test("enter takes the answer the cursor is on, which is no", () => {
    const { component, answers } = prompt();
    component.handleInput("\r");
    expect(answers).toEqual([false]);
  });

  test("enter after moving up means yes", () => {
    const { component, answers } = prompt();
    component.handleInput("\u001b[A");
    component.handleInput("\r");
    expect(answers).toEqual([true]);
  });

  test("it answers once only", () => {
    const { component, answers } = prompt();
    component.handleInput("\u001b");
    component.handleInput("y");
    expect(answers).toEqual([false]);
  });
});

describe("asking with no terminal", () => {
  test("no overlay means no restart", async () => {
    expect(await askRestartConfirm(undefined, request)).toBe(false);
  });

  test("the card the host builds is the one that answers", async () => {
    const approved = await askRestartConfirm(
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
    expect(approved).toBe(true);
  });

  test("closing the card without choosing means no", async () => {
    expect(await askRestartConfirm({ ui: { custom: async () => undefined } }, request)).toBe(false);
  });
});
