// One line in the transcript, e.g. "└ Dynamic workflows dialog dismissed".
//
// Why an entry and not a message: a dismissal is not part of the conversation.
// Sending it as a message would put it in the model's context and wake the
// model up for something the user already knows. A custom entry is drawn in the
// transcript and never sent to the model, which is exactly the right weight.
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

/** The custom entry type; also what the renderer is registered under. */
export const WORKFLOW_NOTE_TYPE = "qronos-workflow-note";

/** What the note says when a panel is closed. */
export const DISMISSED_NOTE = "Dynamic workflows dialog dismissed";

/** The visible words of a note, with the branch mark Claude Code uses. */
export function noteText(message: string): string {
  const clean = String(message ?? "").replace(/\s+/g, " ").trim();
  return clean === "" ? "" : `└ ${clean}`;
}

/**
 * A one-line note, drawn in the muted colour so it reads as a footnote and not
 * as something the assistant said.
 */
export function buildNoteComponent(message: string, theme?: { fg?: (slot: string, text: string) => string }): Component {
  const line = noteText(message);
  return {
    render: (width: number) => {
      if (line === "") return [];
      const cut = line.length > width ? `${line.slice(0, Math.max(0, width - 1))}…` : line;
      let text = cut;
      try {
        const fg = theme?.fg;
        if (typeof fg === "function") text = fg("dim", cut);
      } catch {
        // A theme without the slot is not a reason to hide the line.
      }
      return [text];
    },
  } as Component;
}

/** The tiny surface of the extension API this module needs. */
export interface NoteApi {
  appendEntry?: (customType: string, data?: unknown) => void;
  registerEntryRenderer?: (customType: string, renderer: (...args: any[]) => Component | undefined) => void;
}

/**
 * Register the renderer once. Safe to call twice: the last one wins, and a host
 * without entry renderers simply shows nothing, which is better than throwing.
 */
export function registerWorkflowNoteRenderer(api: NoteApi): void {
  if (typeof api.registerEntryRenderer !== "function") return;
  try {
    api.registerEntryRenderer(WORKFLOW_NOTE_TYPE, (entry: any, _options: any, theme: Theme) =>
      buildNoteComponent(String(entry?.data?.message ?? entry?.data ?? ""), theme as never),
    );
  } catch {
    // Old host: the note is not drawn. The CLI keeps working.
  }
}

/**
 * Put one note in the transcript.
 *
 * Never throws: a dismissed panel must not become an error message just because
 * this host cannot draw entries.
 */
export function appendWorkflowNote(api: NoteApi, message: string): boolean {
  if (typeof api.appendEntry !== "function") return false;
  try {
    api.appendEntry(WORKFLOW_NOTE_TYPE, { message });
    return true;
  } catch {
    return false;
  }
}
