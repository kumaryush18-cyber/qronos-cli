// the explicit, tested no-subagent / no-second-concurrent-
// model-call guarantee. Two describe blocks:
//
// (structural): buildRuntimeOptions()'s own output — the extension
// list is closed, settings pin packages:[] / defaultTools, and the strict
// `tools` allowlist is exactly SAFE_TOOLS plus the two legitimate custom
// tools. Fails immediately if a future edit adds/renames an extension.
//
// (dynamic): a REAL AgentSession, built from buildRuntimeOptions()'s
// actual output (not a hand-rolled stand-in), driven through a real
// multi-turn tool-calling conversation against a stub upstream. Proves
// the shipped distro's own code path never has two completions requests
// open at once, and every tool name it ever calls is in the allowed set.
//
// What this does NOT prove: that a user hasn't hand-edited their own local
// `~/.qronos/agent/extensions/` directory (see the plan's Gap Analysis) —
// that is a client-machine trust boundary this project doesn't claim to
// close. R19 (the session lease, apps/server/src/agent-sessions.ts) is the
// server-side backstop for that residual case, not this test.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { ALLOWED_TOOL_NAMES, buildRuntimeOptions, resolveModelName, type LaunchOptions } from "../src/pi-launch";
import { MODEL_ID, SAFE_TOOLS } from "../src/provider";
import { USAGE_TOOL_NAME } from "../src/usage-tool";
import { DOCS_LOOKUP_TOOL_NAME, WEB_SEARCH_TOOL_NAME } from "../src/web-tools";
import { IMAGE_TOOL_NAME } from "../src/image-tool";
import { BUY_TOOL_NAME } from "../src/buy-tool";
import { DOCS_TOOL_NAME } from "../src/docs-tool";
import { TODO_TOOL_NAME } from "../src/todo-tool";
import { EXIT_PLAN_TOOL_NAME, ENTER_PLAN_TOOL_NAME } from "../src/exit-plan-tool";
import { AGENT_TOOL_NAME, SUBAGENT_READ_ONLY_TOOLS } from "../src/agent-tool";

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function baseOpts(baseUrl: string): LaunchOptions {
  return { baseUrl, jwt: "test-jwt", agentDir: tempDir("qronos-agentdir-") };
}

describe("closed extension list (#28 R20, SB1)", () => {
  test("pi's install telemetry (pi.dev/api/report-install) is disabled", () => {
    const opts = buildRuntimeOptions(baseOpts("http://example.test"), "session-a");
    expect(opts.settingsManager.getEnableInstallTelemetry()).toBe(false);
    expect(process.env.PI_TELEMETRY).toBe("0");
    // pi 1.2.0 default changes we pin back to 0.84 behavior. tuiMode is the
    // exception: fullscreen is what turns on mouse clicks in the editor, so we
    // keep pi's default and offer QRONOS_TUI_MODE=regular for the old one.
    expect(opts.settingsManager.getTuiMode()).toBe("fullscreen");
    expect(opts.settingsManager.getThemeSetting()).toBe("qronos-claude");
  });

  test("buildRuntimeOptions registers exactly the twenty-two known extensions — no more, no less", () => {
    const opts = buildRuntimeOptions(baseOpts("http://example.test"), "session-a");
    // the closed set deliberately grew to six with qronos-buy-tool;
    // 2026-09-01: to seven with qronos-error-notice (one readable line on a
    // 429); 2026-09-03: to eight with qronos-header (the startup header,
    // ); 2026-09-03: to nine with qronos-docs-tool (the qronos_docs
    // tool, U2). Any further addition must be a reviewed, deliberate edit —
    // never accidental. 2026-10-20: to sixteen with qronos-web-tools (web_search, docs_lookup); to seventeen with qronos-image-tool (generate_image).
    // 0.5.0: to eighteen with qronos-exit-plan (plan mode's exit_plan_mode).
    // To nineteen with qronos-file-completion (@file completion fallback for
    // machines where fd cannot be resolved; it adds no tool and no model call).
    // To twenty with qronos-hooks (lifecycle hooks; PreToolUse uses the same
    // tool_call block mechanism as tool-guard and adds no escape hatch).
    // To twenty-one with qronos-agent (task-scoped subagents strictly gated by Option B read-only start).
    // 2026-11-20: twenty-two extensions. qronos-thinking-meter became
    // qronos-working-line: the Claude-Code-style line above the ad box that
    // counts output tokens for the whole run. Still no tool, no model call.
    // 2026-11-21 (later): to twenty-eight with qronos-apply-patch (hashline
    // edits by line range; pi's `edit` stays available) and qronos-lsp (rename,
    // rename_file, diagnostics, hover through a language server). Neither opens
    // a model request; the LSP one spawns a subprocess only when called.
    // 2026-11-21: to twenty-six with three oh-my-pi ports, none of which adds a
    // tool: qronos-stream-rules (aborts a turn on a banned pattern; a no-op
    // until .qronos/stream-rules.json exists), qronos-notify (one desktop
    // notification per long turn) and qronos-advisor (a reviewer model, only
    // when QRONOS_ADVISOR is set). The advisor is the single exception to "no
    // second model call": it runs AFTER turn_end, one at a time, and is off by
    // default, so two completions requests are still never open together.
    // 2026-10-27: qronos-interrupt renamed to qronos-prompt-history. The name
    // changed because the extension NO LONGER touches Escape, which is pi's
    // app.interrupt binding; it only records submitted prompts for /recall. The
    // count is unchanged at twenty-one, and the extension still registers no
    // tool and makes no model call.
    // 2026-11-22: to twenty-nine with qronos-agent-hub: the Agent Hub panel that
    // shows the subagent roster on Alt+A or /agents (part C). It reads the same
    // registry as qronos-agent, registers no tool and makes no model call.
    expect([...opts.extensionNames].sort()).toEqual(
      [
        "qronos-ads",
        "qronos-agent-hub",
        "qronos-buy-tool",
        "qronos-commands",
        "qronos-docs-tool",
        "qronos-error-notice",
        "qronos-fusion",
        "qronos-image-tool",
        "qronos-tool-aliases",
        "qronos-todo",
        "qronos-usage-tool",
        "qronos-web-tools",
        "pi-codemode",
        "pi-mcp",
        "pi-tool-search",
        "qronos-agent",
        "qronos-claude-tool-renderer",
        "qronos-exit-plan",
        "qronos-file-completion",
        "qronos-header",
        "qronos-hooks",
        "qronos-prompt-history",
        "qronos-provider",
        "qronos-working-line",
        "qronos-stream-rules",
        "qronos-notify",
        "qronos-apply-patch",
        "qronos-lsp",
        "qronos-tool-guard",
      ].sort(),
    );
  });

  test("settings pin packages: [] and defaultTools to exactly SAFE_TOOLS plus todo, exit_plan_mode, and agent", () => {
    const opts = buildRuntimeOptions(baseOpts("http://example.test"), "session-b");
    const settings = opts.settingsManager.getGlobalSettings();
    expect(settings.packages).toEqual([]);
    expect([...(settings.defaultTools ?? [])].sort()).toEqual(
      [...SAFE_TOOLS, TODO_TOOL_NAME, EXIT_PLAN_TOOL_NAME, AGENT_TOOL_NAME, "apply_patch", "lsp"].sort(),
    );
  });

 test("settings carry quietStartup: true, hides pi's own header)", () => {
    const opts = buildRuntimeOptions(baseOpts("http://example.test"), "session-quiet");
    const settings = opts.settingsManager.getGlobalSettings();
    expect(settings.quietStartup).toBe(true);
  });

  test("settings clear rows on shrink so the closed @ file list stops painting", () => {
    const opts = buildRuntimeOptions(baseOpts("http://example.test"), "session-shrink");
    expect(opts.settingsManager.getClearOnShrink()).toBe(true);
  });

  test("the strict SDK tools allowlist is exactly SAFE_TOOLS plus the custom tools, todo, exit_plan_mode, agent, apply_patch, lsp, codemode and tool_search", () => {
    const opts = buildRuntimeOptions(baseOpts("http://example.test"), "session-c");
    expect([...opts.tools].sort()).toEqual(
      [
        ...SAFE_TOOLS,
        USAGE_TOOL_NAME,
        BUY_TOOL_NAME,
        DOCS_TOOL_NAME,
        WEB_SEARCH_TOOL_NAME,
        DOCS_LOOKUP_TOOL_NAME,
        IMAGE_TOOL_NAME,
        TODO_TOOL_NAME,
        ENTER_PLAN_TOOL_NAME,
        EXIT_PLAN_TOOL_NAME,
        AGENT_TOOL_NAME,
        "apply_patch",
        "lsp",
        "codemode",
        "tool_search",
        // MCP patterns, so direct-exposure user servers are declared (2026-10-14).
        "mcp__*",
        "list_mcp_resources",
        "list_mcp_resource_templates",
        "read_mcp_resource",
      ].sort(),
    );
    for (const name of ["subagent", "background_bash", "task", "sub_agent", "spawn_agent"]) {
      expect(opts.tools).not.toContain(name);
    }
  });

 test("resolveModelName: catalog name, then model id, then MODEL_ID", () => {
    expect(
      resolveModelName({
        baseUrl: "http://example.test",
        jwt: "t",
        agentDir: tempDir("qronos-agentdir-"),
        models: [{ id: "x", name: "Nice Name" }],
      }),
    ).toBe("Nice Name");
    expect(
      resolveModelName({
        baseUrl: "http://example.test",
        jwt: "t",
        agentDir: tempDir("qronos-agentdir-"),
        models: [],
        model: "deepseek/deepseek-v4-flash",
      }),
    ).toBe("deepseek/deepseek-v4-flash");
    expect(
      resolveModelName({
        baseUrl: "http://example.test",
        jwt: "t",
        agentDir: tempDir("qronos-agentdir-"),
      }),
    ).toBe(MODEL_ID);
  });

  test("SAFE_TOOLS / ALLOWED_TOOL_NAMES never contain an unconstrained background execution tool name", () => {
    const forbidden = ["subagent", "background_bash", "task", "sub_agent", "spawn_agent"];
    for (const name of forbidden) {
      expect(SAFE_TOOLS as readonly string[]).not.toContain(name);
      expect(ALLOWED_TOOL_NAMES).not.toContain(name);
    }
    // Subagents start read-only per Option B
    expect(SUBAGENT_READ_ONLY_TOOLS.has("write")).toBe(false);
    expect(SUBAGENT_READ_ONLY_TOOLS.has("edit")).toBe(false);
  });

  test("codemode, tool_search, apply_patch and lsp are the only new non-MCP names beyond the tools", () => {
    const known = [...SAFE_TOOLS, USAGE_TOOL_NAME, BUY_TOOL_NAME, DOCS_TOOL_NAME, WEB_SEARCH_TOOL_NAME, DOCS_LOOKUP_TOOL_NAME, IMAGE_TOOL_NAME, TODO_TOOL_NAME, ENTER_PLAN_TOOL_NAME, EXIT_PLAN_TOOL_NAME, AGENT_TOOL_NAME];
    // 2026-11-21: apply_patch (hashline edits) and lsp (language server actions)
    // are our own tools, so they must be listed explicitly. Neither runs a model
    // request, and neither can spawn a background process: lsp starts one
    // long-lived language server for the session and kills it on shutdown.
    expect(ALLOWED_TOOL_NAMES.filter((n) => !known.includes(n)).sort()).toEqual([
      "apply_patch",
      "codemode",
      "lsp",
      "tool_search",
    ]);
    expect(ALLOWED_TOOL_NAMES.some((n) => n.startsWith("mcp__"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// stub upstream shaped like the qronos provider's own baseUrl
// (completionsBaseUrl appends /v1; the openai SDK inside pi-ai appends
// /chat/completions to that) — a raw OpenAI-completions-shaped streaming
// endpoint, scripted for exactly one tool call.
// ---------------------------------------------------------------------------

function sseFrame(chunk: unknown): string {
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

/** Turn 1: an assistant message with one tool_call to "bash". */
function toolCallSse(): string {
  const start = {
    id: "resp-1",
    object: "chat.completion.chunk",
    created: 1,
    model: "deepseek/deepseek-v4-flash",
    choices: [
      {
        index: 0,
        delta: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              index: 0,
              id: "call-1",
              type: "function",
              function: { name: "bash", arguments: JSON.stringify({ command: "printf ok" }) },
            },
          ],
        },
        finish_reason: null,
      },
    ],
  };
  const end = {
    id: "resp-1",
    object: "chat.completion.chunk",
    created: 1,
    model: "deepseek/deepseek-v4-flash",
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
  };
  return sseFrame(start) + sseFrame(end) + "data: [DONE]\n\n";
}

/** Turn 2 (after the tool result comes back): plain text ending the turn. */
function finalTextSse(): string {
  const start = {
    id: "resp-2",
    object: "chat.completion.chunk",
    created: 2,
    model: "deepseek/deepseek-v4-flash",
    choices: [{ index: 0, delta: { role: "assistant", content: "done" }, finish_reason: null }],
  };
  const end = {
    id: "resp-2",
    object: "chat.completion.chunk",
    created: 2,
    model: "deepseek/deepseek-v4-flash",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  };
  return sseFrame(start) + sseFrame(end) + "data: [DONE]\n\n";
}

describe("dynamic: a real multi-turn tool-calling AgentSession never opens a 2nd concurrent completion (#28 R20, SB2)", () => {
  test("drives buildRuntimeOptions()'s real production wiring against a stub upstream", async () => {
    let openCount = 0;
    let maxOpen = 0;
    let callCount = 0;
    const toolNamesSeen = new Set<string>();

    const stub = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (req.method !== "POST" || url.pathname !== "/v1/chat/completions") {
          return new Response("not found", { status: 404 });
        }
        openCount++;
        maxOpen = Math.max(maxOpen, openCount);
        try {
          const body = (await req.json()) as { messages?: Array<Record<string, unknown>> };
          for (const msg of body.messages ?? []) {
            const toolCalls = msg.tool_calls as Array<{ function?: { name?: string } }> | undefined;
            for (const tc of toolCalls ?? []) {
              if (tc.function?.name) toolNamesSeen.add(tc.function.name);
            }
          }
          const isFirstCall = callCount === 0;
          callCount++;
          // A short hold before responding: if the harness ever fired a
          // genuinely overlapping second request, it would land while this
          // one is still "open" and maxOpen would catch it.
          await Bun.sleep(15);
          const sse = isFirstCall ? toolCallSse() : finalTextSse();
          return new Response(sse, { headers: { "content-type": "text/event-stream" } });
        } finally {
          openCount--;
        }
      },
    });

    try {
      const baseUrl = stub.url.toString().replace(/\/$/, "");
      const cwd = tempDir("qronos-cwd-");
      const opts: LaunchOptions = { baseUrl, jwt: "test-jwt", agentDir: tempDir("qronos-agentdir-") };
      const { settingsManager, resourceLoaderOptions, tools } = buildRuntimeOptions(opts, "session-dyn-1");

      const services = await createAgentSessionServices({
        cwd,
        agentDir: opts.agentDir,
        settingsManager,
        resourceLoaderOptions,
      });
      const { session } = await createAgentSessionFromServices({
        services,
        sessionManager: SessionManager.inMemory(cwd),
        tools: [...tools],
      });

      try {
        await session.prompt("Run `printf ok` with the bash tool, then say you're done.");
      } finally {
        session.dispose();
      }

      expect(maxOpen).toBeLessThanOrEqual(1);
      expect(callCount).toBeGreaterThanOrEqual(1);
      // Sanity: the scripted tool call really happened — rules out a false
      // negative from the stub silently not being exercised.
      expect(toolNamesSeen.size).toBeGreaterThan(0);
      for (const name of toolNamesSeen) {
        expect(ALLOWED_TOOL_NAMES).toContain(name);
      }
    } finally {
      stub.stop(true);
    }
  }, 20_000);
});

/** An assistant turn with one tool_call of any name. */
function namedToolCallSse(name: string, args: unknown): string {
  const base = { id: "resp-m", object: "chat.completion.chunk", created: 3, model: "deepseek/deepseek-v4-flash" };
  const start = {
    ...base,
    choices: [
      {
        index: 0,
        delta: {
          role: "assistant",
          content: null,
          tool_calls: [{ index: 0, id: "call-m", type: "function", function: { name, arguments: JSON.stringify(args) } }],
        },
        finish_reason: null,
      },
    ],
  };
  const end = { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] };
  return sseFrame(start) + sseFrame(end) + "data: [DONE]\n\n";
}

describe("dynamic: codemode calling a user-added MCP server stays one request at a time (2026-10-13, SB2 + Q3)", () => {
  test("a codemode script calls a stub stdio MCP tool; the guard admits it and no 2nd completion opens", async () => {
    let openCount = 0;
    let maxOpen = 0;
    let callCount = 0;
    const toolNamesSeen = new Set<string>();
    const otherPaths: string[] = [];
    let secondRequestBody = "";

    const stub = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (req.method !== "POST" || url.pathname !== "/v1/chat/completions") {
          otherPaths.push(url.pathname);
          return new Response("not found", { status: 404 });
        }
        openCount++;
        maxOpen = Math.max(maxOpen, openCount);
        try {
          const raw = await req.text();
          const body = JSON.parse(raw) as { messages?: Array<Record<string, unknown>> };
          for (const msg of body.messages ?? []) {
            const toolCalls = msg.tool_calls as Array<{ function?: { name?: string } }> | undefined;
            for (const tc of toolCalls ?? []) {
              if (tc.function?.name) toolNamesSeen.add(tc.function.name);
            }
          }
          const isFirstCall = callCount === 0;
          if (callCount === 1) secondRequestBody = raw;
          callCount++;
          await Bun.sleep(15);
          const sse = isFirstCall
            ? namedToolCallSse("codemode", {
                code: 'const r = await tools.mcp__stub__echo({ text: "hi" }); return JSON.stringify(r);',
              })
            : finalTextSse();
          return new Response(sse, { headers: { "content-type": "text/event-stream" } });
        } finally {
          openCount--;
        }
      },
    });

    try {
      const baseUrl = stub.url.toString().replace(/\/$/, "");
      const cwd = tempDir("qronos-cwd-");
      const opts: LaunchOptions = { baseUrl, jwt: "test-jwt", agentDir: tempDir("qronos-agentdir-") };
      const server = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "stub-mcp-server.mjs");
      writeFileSync(
        join(opts.agentDir, "mcp.json"),
        JSON.stringify({ mcpServers: { stub: { command: process.execPath, args: [server] } } }),
      );
      const { settingsManager, resourceLoaderOptions, tools } = buildRuntimeOptions(opts, "session-dyn-mcp");

      const services = await createAgentSessionServices({
        cwd,
        agentDir: opts.agentDir,
        settingsManager,
        resourceLoaderOptions,
      });
      const { session } = await createAgentSessionFromServices({
        services,
        sessionManager: SessionManager.inMemory(cwd),
        tools: [...tools],
      });

      try {
        await session.bindExtensions({});
        await session.prompt("Call the stub echo tool through codemode.");
      } finally {
        session.dispose();
      }

      expect(maxOpen).toBeLessThanOrEqual(1);
      expect(callCount).toBe(2);
      // The only tool the model ever called is codemode, which is allowlisted.
      expect(toolNamesSeen).toEqual(new Set(["codemode"]));
      for (const name of toolNamesSeen) expect(ALLOWED_TOOL_NAMES).toContain(name);
      // The script really reached the MCP server: its output came back in the 2nd request.
      expect(secondRequestBody).toContain("echo:hi");
      // The production guard blocked nothing: it would have POSTed /telemetry/tool-guard.
      expect(otherPaths).not.toContain("/telemetry/tool-guard");
    } finally {
      stub.stop(true);
    }
  }, 30_000);
});
