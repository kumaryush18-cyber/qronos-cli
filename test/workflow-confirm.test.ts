import { describe, expect, test } from "bun:test";
import { ConfirmPrompt, askConfirm, buildConfirmLines } from "../src/workflow-confirm";

const plain = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, "");

const request = {
  title: "Save the change?",
  lines: [".qronos/workflows/review.js", "the file on disk would be replaced"],
  yes: "Yes, save it",
  no: "No, leave the file alone",
};

const text = (overrides: Record<string, unknown> = {}) =>
  buildConfirmLines({ request, selected: 1, width: 62, ...overrides })
    .map((line) => line.text)
    .join("\n");

describe("the confirm card", () => {
  test("it asks the question and shows the facts", () => {
    const shown = text();
    expect(shown).toContain("Save the change?");
    expect(shown).toContain(".qronos/workflows/review.js");
    expect(shown).toContain("the file on disk would be replaced");
  });

  test("the safe answer is the one the cursor starts on", () => {
    expect(text()).toContain("▸ 2. No, leave the file alone");
  });

  test("the cursor can move to yes", () => {
    expect(text({ selected: 0 })).toContain("▸ 1. Yes, save it");
  });

  test("at most four facts are shown, so the answers stay on the card", () => {
    const many = { ...request, lines: ["a", "b", "c", "d", "e"] };
    const shown = buildConfirmLines({ request: many, selected: 1, width: 62 });
    expect(shown.filter((line) => line.style === "subtitle").length).toBe(4);
  });
});

function prompt() {
  const answers: boolean[] = [];
  const component = new ConfirmPrompt({
    request,
    theme: { fg: (_slot: string, value: string) => value } as never,
    done: (value) => answers.push(value),
  });
  return { component, answers };
}

describe("the confirm prompt", () => {
  test("it draws a bordered card of the width it is given", () => {
    const lines = prompt().component.render(56);
    expect(plain(lines[0]!)).toStartWith("╭");
    expect(plain(lines.at(-1)!)).toStartWith("╰");
    for (const line of lines) expect(plain(line).length).toBe(56);
  });

  test("enter alone means no", () => {
    const { component, answers } = prompt();
    component.handleInput("\r");
    expect(answers).toEqual([false]);
  });

  test("esc means no, and so do n and 2", () => {
    for (const key of ["\u001b", "n", "2"]) {
      const { component, answers } = prompt();
      component.handleInput(key);
      expect(answers).toEqual([false]);
    }
  });

  test("y means yes, and so does 1", () => {
    for (const key of ["y", "1"]) {
      const { component, answers } = prompt();
      component.handleInput(key);
      expect(answers).toEqual([true]);
    }
  });

  test("up then enter means yes", () => {
    const { component, answers } = prompt();
    component.handleInput("\u001b[A");
    component.handleInput("\r");
    expect(answers).toEqual([true]);
  });

  test("down from no stays on no", () => {
    const { component, answers } = prompt();
    component.handleInput("\u001b[B");
    component.handleInput("\r");
    expect(answers).toEqual([false]);
  });

  test("it answers once only", () => {
    const { component, answers } = prompt();
    component.handleInput("y");
    component.handleInput("\u001b");
    expect(answers).toEqual([true]);
  });
});

describe("asking with no terminal", () => {
  test("no overlay means no", async () => {
    expect(await askConfirm(undefined, request)).toBe(false);
  });

  test("the card the host builds is the one that answers", async () => {
    expect(
      await askConfirm(
        {
          ui: {
            custom: async (build: any) => {
              const component = build({ requestRender: () => {} }, { fg: (_s: string, t: string) => t }, {}, () => {});
              component.handleInput("y");
            },
          },
        },
        request,
      ),
    ).toBe(true);
  });

  test("closing the card without choosing means no", async () => {
    expect(await askConfirm({ ui: { custom: async () => undefined } }, request)).toBe(false);
  });
});
