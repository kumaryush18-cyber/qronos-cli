// U2: mirrors usage-tool.test.ts's Proxy stub — a fake ExtensionAPI that
// records every call so a structural assertion ("only registerTool, nothing
// else") is meaningful rather than trivially true.
import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createDocsToolExtension, DOCS_TOOL_NAME } from "../src/docs-tool";
import { QRONOS_DOCS } from "../src/docs";
import { ALLOWED_TOOL_NAMES } from "../src/pi-launch";

type ToolCall = {
  name: string;
  label: string;
  description: string;
  promptSnippet: string;
  parameters: unknown;
  execute: (
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: unknown,
  ) => Promise<{ content: Array<{ type: string; text: string }>; details: unknown }>;
};

function createFakePi(): {
  pi: ExtensionAPI;
  onEvents: string[];
  calls: Array<{ method: string; args: unknown[] }>;
} {
  const onEvents: string[] = [];
  const calls: Array<{ method: string; args: unknown[] }> = [];

  const pi = new Proxy(
    {},
    {
      get(_target, prop: string) {
        if (prop === "on") {
          return (event: string) => {
            onEvents.push(event);
          };
        }
        return (...args: unknown[]) => {
          calls.push({ method: prop, args });
          return undefined;
        };
      },
    },
  ) as unknown as ExtensionAPI;

  return { pi, onEvents, calls };
}

function registerAndGetTool(): ToolCall {
  const { pi, onEvents, calls } = createFakePi();
  const ext = createDocsToolExtension() as { name: string; factory: (pi: ExtensionAPI) => void };
  expect(ext.name).toBe("qronos-docs-tool");
  ext.factory(pi);

  expect(onEvents).toEqual([]);
  expect(calls.every((c) => c.method === "registerTool")).toBe(true);
  expect(calls).toHaveLength(1);

  return calls[0]!.args[0] as ToolCall;
}

describe("createDocsToolExtension", () => {
  test("registers no event handlers and exactly one tool, named qronos_docs, with the R6 prompt snippet and description", () => {
    const tool = registerAndGetTool();
    expect(tool.name).toBe(DOCS_TOOL_NAME);
    expect(tool.name).toBe("qronos_docs");
    expect(tool.label).toBe("About qronos");
    expect(tool.description).toBe("Returns the built-in qronos guide. Read-only, takes no arguments, makes no network calls.");
    expect(tool.promptSnippet).toBe(
      "Explain qronos itself: what it is, how the free allowance and ads work, credits, and the qronos slash commands",
    );
    // R9: no argument exists that could mutate anything.
    expect(tool.parameters).toEqual({ type: "object", properties: {} });
  });

  test("execute() resolves to a text block equal to QRONOS_DOCS", async () => {
    const tool = registerAndGetTool();
    const result = await tool.execute("call-1", {}, undefined, undefined, {});
    expect(result.content).toEqual([{ type: "text", text: QRONOS_DOCS }]);
    expect(result.details).toEqual({ ok: true });
  });
});

describe("QRONOS_DOCS content (R7, R9)", () => {
  test("contains the six headings", () => {
    for (const heading of [
      "# qronos",
      "## What qronos is",
      "## Ads and your data",
      "## The free allowance",
      "## Credits",
      "## Commands",
      "## Support",
    ]) {
      expect(QRONOS_DOCS).toContain(heading);
    }
  });

  test("contains the eight command names", () => {
    for (const cmd of [
      "/usage",
      "/support",
      "/tos",
      "/privacy-policy",
      "/buy-credits",
      "/close-other-session",
      "/update",
      "/whats-new",
    ]) {
      expect(QRONOS_DOCS).toContain(cmd);
    }
  });

  test("documents the todo list and MCP servers", () => {
    for (const text of ["## Todo list", "## MCP servers", "/todos", "/mcp", "qronos-cli mcp add", "~/.qronos/agent/mcp.json"]) {
      expect(QRONOS_DOCS).toContain(text);
    }
  });

  test("contains no ad creative, advertiser name, or price", () => {
    expect(QRONOS_DOCS).not.toContain("AD ░▒▓");
    expect(QRONOS_DOCS).not.toContain("Honcho");
    expect(QRONOS_DOCS).not.toContain("slop.cash");
    expect(QRONOS_DOCS).not.toContain("$");
  });
});

describe("ALLOWED_TOOL_NAMES includes qronos_docs (R8)", () => {
  test("qronos_docs is in the CLI's allowed tool list", () => {
    expect(ALLOWED_TOOL_NAMES).toContain("qronos_docs");
    expect(ALLOWED_TOOL_NAMES).toContain(DOCS_TOOL_NAME);
  });
});
