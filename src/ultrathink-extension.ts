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
import { ULTRATHINK_SECTION, ULTRATHINK_STATUS, hasUltrathink, ultrathinkSection } from "./ultrathink";

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
      if (!hasUltrathink(prompt)) return;
      const fields = (event as { systemPromptOptions?: { sections?: Record<string, string> } }).systemPromptOptions;
      if (fields?.sections) fields.sections[ULTRATHINK_SECTION] = ultrathinkSection();
      ctx.ui.setStatus(ULTRATHINK_SECTION, ULTRATHINK_STATUS);
    });
  };
  return { name: "qronos-ultrathink", factory: extension };
}
