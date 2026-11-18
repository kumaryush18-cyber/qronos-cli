// the qronos guide as a read-only pi tool, mirroring
// usage-tool.ts's shape (own module, empty parameter schema, no event
// handlers, never throws, never touches the network or filesystem).
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { QRONOS_DOCS } from "./docs";

// style: the one custom tool name needed by pi-launch.ts's tool-guard
// allowlist and the SDK's own strict `tools` allowlist so this tool isn't
// blocked as if it were rogue.
export const DOCS_TOOL_NAME = "qronos_docs";

const PARAMS = Type.Object({});

export function createDocsToolExtension(): InlineExtension {
  return {
    name: "qronos-docs-tool",
    factory(qronos: ExtensionAPI) {
      qronos.registerTool({
        name: DOCS_TOOL_NAME,
        label: "About qronos",
        description: "Returns the built-in qronos guide. Read-only, takes no arguments, makes no network calls.",
        promptSnippet: "Explain qronos itself: what it is, how the free allowance and ads work, credits, and the qronos slash commands",
        parameters: PARAMS,
        async execute() {
          return {
            content: [{ type: "text" as const, text: QRONOS_DOCS }],
            details: { ok: true },
          };
        },
      });
    },
  };
}
