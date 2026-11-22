import { describe, expect, test } from "bun:test";
import {
  DISMISSED_NOTE,
  WORKFLOW_NOTE_TYPE,
  appendWorkflowNote,
  buildNoteComponent,
  noteText,
  registerWorkflowNoteRenderer,
} from "../src/workflow-note";

describe("a workflow note", () => {
  test("it is drawn with the branch mark Claude Code uses", () => {
    expect(noteText(DISMISSED_NOTE)).toBe("└ Dynamic workflows dialog dismissed");
  });

  test("the words are the ones on the screenshot", () => {
    expect(DISMISSED_NOTE).toBe("Dynamic workflows dialog dismissed");
  });

  test("an empty note draws nothing at all", () => {
    expect(noteText("")).toBe("");
    expect(noteText("   ")).toBe("");
    expect(buildNoteComponent("").render(80)).toEqual([]);
  });

  test("extra spaces collapse, so the line is always one line", () => {
    expect(noteText("a  b\nc")).toBe("└ a b c");
  });

  test("a narrow terminal gets a cut line", () => {
    const lines = buildNoteComponent(DISMISSED_NOTE).render(12);
    expect(lines[0]).toHaveLength(12);
    expect(lines[0]!.endsWith("…")).toBe(true);
  });

  test("the theme colours it when the theme has a dim slot", () => {
    const lines = buildNoteComponent(DISMISSED_NOTE, { fg: (slot, text) => (slot === "dim" ? `<dim>${text}` : text) }).render(80);
    expect(lines[0]).toContain("<dim>");
  });

  test("a theme that throws is ignored, not fatal", () => {
    const lines = buildNoteComponent(DISMISSED_NOTE, {
      fg: () => {
        throw new Error("no such slot");
      },
    }).render(80);
    expect(lines[0]).toBe("└ Dynamic workflows dialog dismissed");
  });
});

describe("appending a note", () => {
  test("it is stored under the workflow note type", () => {
    const entries: { type: string; data: unknown }[] = [];
    const api = { appendEntry: (type: string, data: unknown) => entries.push({ type, data }) };
    expect(appendWorkflowNote(api, DISMISSED_NOTE)).toBe(true);
    expect(entries[0]!.type).toBe(WORKFLOW_NOTE_TYPE);
    expect((entries[0]!.data as { message: string }).message).toBe(DISMISSED_NOTE);
  });

  test("a host without appendEntry is not an error", () => {
    expect(appendWorkflowNote({}, DISMISSED_NOTE)).toBe(false);
  });

  test("a host that throws is not an error", () => {
    const api = {
      appendEntry: () => {
        throw new Error("no session");
      },
    };
    expect(appendWorkflowNote(api, DISMISSED_NOTE)).toBe(false);
  });

  test("the renderer is registered for the same type", () => {
    const seen: string[] = [];
    registerWorkflowNoteRenderer({ registerEntryRenderer: (type) => seen.push(type) });
    expect(seen).toEqual([WORKFLOW_NOTE_TYPE]);
  });

  test("the registered renderer draws the words of the entry", () => {
    let renderer: ((entry: any, options: any, theme: any) => any) | undefined;
    registerWorkflowNoteRenderer({
      registerEntryRenderer: (_type, fn) => {
        renderer = fn;
      },
    });
    const component = renderer!({ data: { message: DISMISSED_NOTE } }, {}, { fg: (_slot: string, text: string) => text });
    expect(component.render(80)[0]).toBe("└ Dynamic workflows dialog dismissed");
  });

  test("a host without renderers is not an error", () => {
    expect(() => registerWorkflowNoteRenderer({})).not.toThrow();
  });
});
