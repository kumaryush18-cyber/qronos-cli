// The save screen: it must show the name already filled in, and Enter / Esc
// must answer exactly once.
import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { ExportSavePanel } from "../src/export-panel";

function panel(initialName = "2026-11-23-104846-hi.txt") {
  const answers: Array<string | undefined> = [];
  const instance = new ExportSavePanel({ initialName, done: (name) => answers.push(name) });
  return { instance, answers };
}

describe("ExportSavePanel", () => {
  test("the name is prefilled", () => {
    const { instance } = panel();
    expect(instance.value()).toBe("2026-11-23-104846-hi.txt");
  });

  test("the screen says what it is and how to leave", () => {
    const { instance } = panel();
    const lines = instance.render(52);
    const text = lines.join("\n");
    expect(text).toContain("Export conversation");
    expect(text).toContain("File name");
    expect(text).toContain("Enter to save");
    expect(text).toContain("Esc to go back");
  });

  test("typing changes the name", () => {
    const { instance } = panel("a.txt");
    instance.handleInput("b");
    expect(instance.value()).toBe("a.txtb");
  });

  test("Enter answers with the name as typed", () => {
    const { instance, answers } = panel("mine.txt");
    instance.handleInput("\r");
    expect(answers).toEqual(["mine.txt"]);
  });

  test("Esc answers with nothing, which means no file", () => {
    const { instance, answers } = panel();
    instance.handleInput("\u001b");
    expect(answers).toEqual([undefined]);
  });

  test("every line fits the panel width", () => {
    const { instance } = panel("a-rather-long-name-for-a-conversation.txt");
    for (const width of [40, 52, 74]) {
      for (const line of instance.render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });
});
