// `ultrathink` wired into pi.
//
// Two things happen, both free (no model call):
//   - the input box paints the word in orange with a pale band flowing through;
//   - the prompt that contains the word gets one extra system-prompt section
//     for that turn only.
//
// Off switch: `QRONOS_ULTRATHINK=0`. Nothing else changes.
import type { ExtensionAPI, ExtensionContext, InlineExtension } from "@earendil-works/pi-coding-agent";
import { UltrathinkEditor, type UltrathinkEditorOptions } from "./ultrathink-editor";
import type { Keyword } from "./ultrathink";
import { ULTRATHINK_SECTION, ULTRATHINK_STATUS, hasKeyword, hasUltrathink, ultrathinkSection } from "./ultrathink";
import { KEYWORD_SECTIONS } from "./workflow-notice";

export interface UltrathinkConfig {
  enabled: boolean;
  /** Paint the word in the input box. */
  paint: boolean;
}

export function ultrathinkConfigFromEnv(env: NodeJS.ProcessEnv = process.env): UltrathinkConfig {
  const off = env.QRONOS_ULTRATHINK === "0" || env.QRONOS_ULTRATHINK === "false";
  return { enabled: !off, paint: !off };
}

export interface UltrathinkExtensionOptions {
  config?: UltrathinkConfig;
  /** Injected in tests. */
  editorOptions?: UltrathinkEditorOptions;
}

export function createUltrathinkExtension(options: UltrathinkExtensionOptions = {}): InlineExtension {
  const config = options.config ?? ultrathinkConfigFromEnv();
  const extension = (qronos: ExtensionAPI): void => {
    qronos.on("session_start", async (_event, ctx: ExtensionContext) => {
      if (!config.enabled || !config.paint) return;
      try {
        ctx.ui.setEditorComponent(
          (tui, theme, keybindings) => new UltrathinkEditor(tui, theme, keybindings, options.editorOptions),
        );
      } catch {
        // A terminal that cannot host a custom editor still gets the notice.
      }
    });

    qronos.on("before_agent_start", async (event, ctx: ExtensionContext) => {
      if (!config.enabled) return;
      const prompt = (event as { prompt?: string }).prompt ?? "";
      const fields = (event as { systemPromptOptions?: { sections?: Record<string, string> } }).systemPromptOptions;

      if (hasUltrathink(prompt)) {
        if (fields?.sections) fields.sections[ULTRATHINK_SECTION] = ultrathinkSection();
        ctx.ui.setStatus(ULTRATHINK_SECTION, ULTRATHINK_STATUS);
      }

      // ultracode / orchestrate: their notices name a tool that exists
      // (`workflow` for ultracode, `agent` for orchestrate), so they are only
      // added when the matching word is present. Each word is independent, so
      // one early `return` above must not hide the others.
      for (const word of Object.keys(KEYWORD_SECTIONS) as Keyword[]) {
        const entry = KEYWORD_SECTIONS[word];
        if (!entry || !hasKeyword(prompt, word)) continue;
        if (fields?.sections) fields.sections[entry.section] = entry.build();
        ctx.ui.setStatus(entry.section, `${word} on`);
      }
    });
  };
  return { name: "qronos-ultrathink", factory: extension };
}
