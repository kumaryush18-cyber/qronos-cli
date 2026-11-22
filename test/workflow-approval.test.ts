import { afterEach, describe, expect, test } from "bun:test";
import {
  APPROVAL_HEIGHT,
  ASK_FROM_AGENTS,
  WorkflowApprovalPrompt,
  approvalModeFromEnv,
  approvalRequestFor,
  askWorkflowApproval,
  buildApprovalLines,
  editScriptInEditor,
  estimateAgentCalls,
  needsApproval,
  type ApprovalOutcome,
  type ApprovalPromptOptions,
  type ApprovalRequest,
  type ApprovalState,
} from "../src/workflow-approval";
import { parseWorkflowMeta } from "../src/workflow-sandbox";
import { visibleLength } from "../src/workflow-panel";

const plainTheme = { fg: (_slot: string, text: string) => text } as never;
const plain = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, "");

const bigScript = `
  export const meta = {
    name: "map",
    description: "study the tree by purpose",
    phases: [{ title: "Analyze", agents: 5, prompt: "one file each" }, { title: "Review" }],
  }
  const areas = ["a", "b", "c", "d", "e"]
  const out = await parallel(areas.map((a) => () => agent("study " + a)))
  return out
`;

const request = (overrides: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
  ...approvalRequestFor(bigScript, "fallback"),
  ...overrides,
});

const state = (overrides: Partial<ApprovalState> = {}): ApprovalState => ({
  request: request(),
  selected: 0,
  mode: "ask",
  width: 74,
  now: 0,
  ...overrides,
});

const text = (lines: { text: string }[]) => lines.map((line) => line.text).join("\n");

describe("when a run is questioned", () => {
  test("the default mode is ask", () => {
    expect(approvalModeFromEnv({})).toBe("ask");
    expect(approvalModeFromEnv({ QRONOS_WORKFLOW_APPROVE: "ask" })).toBe("ask");
  });

  test("0 and off turn the questions off", () => {
    expect(approvalModeFromEnv({ QRONOS_WORKFLOW_APPROVE: "0" })).toBe("never");
    expect(approvalModeFromEnv({ QRONOS_WORKFLOW_APPROVE: "off" })).toBe("never");
  });

  test("always asks for every run", () => {
    expect(approvalModeFromEnv({ QRONOS_WORKFLOW_APPROVE: "always" })).toBe("always");
  });

  test("a tiny run is not interrupted", () => {
    const tiny = approvalRequestFor(`const one = await agent("look"); return one.text;`);
    expect(needsApproval(tiny, "ask")).toBe(false);
  });

  test("three written agent calls is enough to ask", () => {
    const big = approvalRequestFor(`await agent("a"); await agent("b"); await agent("c");`);
    expect(big.estimatedAgents).toBeGreaterThanOrEqual(ASK_FROM_AGENTS);
    expect(needsApproval(big, "ask")).toBe(true);
  });

  test("a declared plan of three agents asks even when the script is small", () => {
    const planned = approvalRequestFor(`export const meta = { phases: [{ title: "Go", agents: 3 }] }\nreturn 1`);
    expect(planned.estimatedAgents).toBeLessThan(3);
    expect(needsApproval(planned, "ask")).toBe(true);
  });

  test("two phases ask, because the plan is already wide", () => {
    const planned = approvalRequestFor(`export const meta = { phases: [{ title: "A" }, { title: "B" }] }\nreturn 1`);
    expect(needsApproval(planned, "ask")).toBe(true);
  });

  test("never and always win over the size", () => {
    expect(needsApproval(request(), "never")).toBe(false);
    expect(needsApproval(approvalRequestFor("return 1"), "always")).toBe(true);
  });
});

describe("the estimate", () => {
  test("counts agent calls", () => {
    expect(estimateAgentCalls(`await agent("a"); await agent("b")`)).toBe(2);
  });

  test("counts a pipeline and a parallel as more than one", () => {
    expect(estimateAgentCalls(`await pipeline(list, (x) => agent(x))`)).toBeGreaterThanOrEqual(3);
  });

  test("a script with no agents is zero", () => {
    expect(estimateAgentCalls("return 1")).toBe(0);
  });

  test("agent inside a word is not a call", () => {
    expect(estimateAgentCalls("const subagent = 1")).toBe(0);
  });
});

describe("the plan comes from meta, without running anything", () => {
  test("name, description and phases are read", () => {
    const meta = parseWorkflowMeta(bigScript);
    expect(meta.name).toBe("map");
    expect(meta.description).toContain("purpose");
    expect(meta.phases).toHaveLength(2);
    expect(meta.phases![0]!.agents).toBe(5);
  });

  test("a plain string in the phase list is a title", () => {
    expect(parseWorkflowMeta(`export const meta = { phases: ["Read", "Write"] }`).phases).toEqual([
      { title: "Read", agents: undefined, prompt: undefined },
      { title: "Write", agents: undefined, prompt: undefined },
    ]);
  });

  test("a nonsense phase list is dropped, not guessed", () => {
    expect(parseWorkflowMeta(`export const meta = { phases: 5 }`).phases).toBeUndefined();
    expect(parseWorkflowMeta(`export const meta = { phases: [null, 3, {}] }`).phases).toBeUndefined();
  });

  test("a long phase list is cut to twelve", () => {
    const many = Array.from({ length: 20 }, (_, index) => `"P${index}"`).join(", ");
    expect(parseWorkflowMeta(`export const meta = { phases: [${many}] }`).phases).toHaveLength(12);
  });

  test("a trailing comma does not break the preview", () => {
    const meta = parseWorkflowMeta(`export const meta = { phases: [{ title: "A", agents: 2, },], }`);
    expect(meta.phases).toHaveLength(1);
  });

  test("an odd agents value is clamped", () => {
    const meta = parseWorkflowMeta(`export const meta = { phases: [{ title: "A", agents: -4 }, { title: "B", agents: 99999 }] }`);
    expect(meta.phases![0]!.agents).toBeUndefined();
    expect(meta.phases![1]!.agents).toBe(1000);
  });
});

describe("the card", () => {
  test("the name is asked about, next to the title", () => {
    const lines = text(buildApprovalLines(state()));
    expect(lines).toContain("Run a dynamic workflow?");
    expect(lines).toContain("map");
  });

  test("the description is shown", () => {
    expect(text(buildApprovalLines(state()))).toContain("study the tree by purpose");
  });

  test("phases are numbered with their agent counts", () => {
    const lines = text(buildApprovalLines(state()));
    expect(lines).toContain("1. Analyze — 5 agents");
    expect(lines).toContain("2. Review");
  });

  test("a sample prompt is quoted under its phase", () => {
    expect(text(buildApprovalLines(state()))).toContain('· "one file each"');
  });

  test("the warning names the cost, /workflows and the switch", () => {
    const lines = text(buildApprovalLines(state({ request: request({ lastTokens: 12_000 }) })));
    expect(lines).toContain("/workflows");
    expect(lines).toContain("QRONOS_WORKFLOW_APPROVE=0");
    expect(lines).toContain("12,000 tokens");
  });

  test("three options, the first one selected", () => {
    const lines = buildApprovalLines(state());
    const options = lines.filter((line) => line.style === "option" || line.style === "option-selected");
    expect(options).toHaveLength(3);
    expect(options[0]!.text).toContain("▸");
    expect(options[0]!.text).toContain("Yes, run it");
    expect(options[1]!.text).toContain("View raw script");
    expect(options[2]!.text).toContain("No");
  });

  test("the keys are on the card", () => {
    const lines = text(buildApprovalLines(state()));
    expect(lines).toContain("tab amend");
    expect(lines).toContain("$EDITOR");
    expect(lines).toContain("esc cancel");
  });

  test("the script view shows code and says how much is hidden", () => {
    const long = Array.from({ length: 40 }, (_, index) => `const a${index} = ${index}`).join("\n");
    const lines = text(buildApprovalLines(state({ mode: "script", request: request({ script: long }) })));
    expect(lines).toContain("The script that will run");
    expect(lines).toContain("more lines");
  });

  test("amending shows what is being typed", () => {
    const lines = text(buildApprovalLines(state({ amended: "a shorter description" })));
    expect(lines).toContain("a shorter description");
    expect(lines).toContain("enter keeps it");
  });

  test("every line fits the width", () => {
    for (const width of [40, 74, 120]) {
      for (const line of buildApprovalLines(state({ width }))) {
        expect(line.text.length).toBeLessThanOrEqual(width - 4);
      }
    }
  });
});

describe("the keys", () => {
  let outcome: ApprovalOutcome | undefined;
  const prompt = (options: Partial<ApprovalPromptOptions> = {}) => {
    outcome = undefined;
    return new WorkflowApprovalPrompt({
      request: request(),
      theme: plainTheme,
      done: (result) => {
        outcome = result;
      },
      width: 74,
      now: () => 0,
      ...options,
    });
  };

  test("the card is a box", () => {
    const lines = prompt().render(74);
    expect(lines[0]!.startsWith("╭")).toBe(true);
    expect(lines.at(-1)!.startsWith("╰")).toBe(true);
  });

  test("the heading glows, so it carries colour codes", () => {
    const first = prompt().render(74)[1]!;
    expect(plain(first)).toContain("Run a dynamic workflow?");
    expect(first).toContain("\u001b[");
  });

  test("every line is the same width", () => {
    const lines = prompt().render(74);
    const widths = new Set(lines.map((line) => visibleLength(line)));
    expect(widths.size).toBe(1);
  });

  test("enter on the first option runs it", () => {
    const panel = prompt();
    panel.handleInput("\r");
    expect(outcome?.approved).toBe(true);
  });

  test("3 says no", () => {
    const panel = prompt();
    panel.handleInput("3");
    expect(outcome?.approved).toBe(false);
  });

  test("escape says no", () => {
    const panel = prompt();
    panel.handleInput("\u001b");
    expect(outcome?.approved).toBe(false);
  });

  test("2 opens the script and escape comes back to the question", () => {
    const panel = prompt();
    panel.handleInput("2");
    expect(panel.mode).toBe("script");
    expect(plain(panel.render(74).join("\n"))).toContain("The script that will run");
    panel.handleInput("\u001b");
    expect(panel.mode).toBe("ask");
    expect(outcome).toBeUndefined();
  });

  test("1 selects without running, enter then runs", () => {
    const panel = prompt();
    panel.handleInput("\u001b");
    expect(outcome?.approved).toBe(false);
    const second = prompt();
    second.handleInput("1");
    expect(outcome).toBeUndefined();
    second.handleInput("\r");
    expect(outcome?.approved).toBe(true);
  });

  test("arrows move the choice and enter picks it", () => {
    const panel = prompt();
    panel.handleInput("\u001b[B");
    panel.handleInput("\u001b[B");
    expect(panel.selected).toBe(2);
    panel.handleInput("\r");
    expect(outcome?.approved).toBe(false);
  });

  test("tab amends the description and enter runs with it", () => {
    const panel = prompt();
    panel.handleInput("\t");
    expect(panel.amended).toBe("study the tree by purpose");
    for (const char of " (edited)") panel.handleInput(char);
    panel.handleInput("\r");
    expect(outcome?.approved).toBe(true);
    expect(outcome?.description).toContain("(edited)");
  });

  test("backspace edits, escape drops the change", () => {
    const panel = prompt();
    panel.handleInput("\t");
    panel.handleInput("\u007f");
    expect(panel.amended!.length).toBe("study the tree by purpose".length - 1);
    panel.handleInput("\u001b");
    expect(panel.amended).toBeUndefined();
    expect(outcome).toBeUndefined();
  });

  test("ctrl+g replaces the script with what the editor saved", () => {
    const panel = prompt({ edit: () => `return "edited"` });
    panel.handleInput("\u0007");
    expect(panel.script).toBe(`return "edited"`);
    panel.handleInput("\r");
    expect(outcome?.script).toBe(`return "edited"`);
  });

  test("an editor that saves nothing keeps the old script", () => {
    const panel = prompt({ edit: () => undefined });
    panel.handleInput("\u0007");
    expect(panel.script).toBe(request().script);
  });

  test("the answer arrives once, even if a key is pressed twice", () => {
    let calls = 0;
    const panel = new WorkflowApprovalPrompt({
      request: request(),
      theme: plainTheme,
      done: () => {
        calls += 1;
      },
      now: () => 0,
    });
    panel.handleInput("\r");
    panel.handleInput("\r");
    expect(calls).toBe(1);
  });
});

describe("asking in the session", () => {
  test("no terminal means no question, and the run goes ahead", async () => {
    const result = await askWorkflowApproval({}, request());
    expect(result.approved).toBe(true);
    expect(result.skipped).toBe(true);
  });

  test("a tiny run is not asked about at all", async () => {
    let asked = 0;
    const ctx = {
      ui: {
        custom: async () => {
          asked += 1;
        },
      },
    };
    const result = await askWorkflowApproval(ctx, approvalRequestFor(`await agent("one")`));
    expect(result.approved).toBe(true);
    expect(asked).toBe(0);
  });

  test("the card is shown as a centred overlay", async () => {
    const seen: Record<string, any>[] = [];
    const ctx = {
      ui: {
        custom: async (build: any, options: Record<string, any>) => {
          seen.push(options);
          build({ requestRender: () => {} }, plainTheme, {}, () => {});
        },
      },
    };
    const result = await askWorkflowApproval(ctx, request());
    expect(seen[0]!.overlay).toBe(true);
    expect(seen[0]!.overlayOptions.anchor).toBe("center");
    // Closing without choosing must never start a run.
    expect(result.approved).toBe(false);
  });

  test("a card that is answered yes returns the edited script", async () => {
    const ctx = {
      ui: {
        custom: async (build: any) => {
          const panel = build({ requestRender: () => {} }, plainTheme, {}, () => {});
          panel.handleInput("2");
          panel.handleInput("\u001b");
          panel.handleInput("\r");
        },
      },
    };
    const result = await askWorkflowApproval(ctx, request());
    expect(result.approved).toBe(true);
    expect(result.script).toBe(request().script);
  });

  test("the height the overlay is given is the one the docs promise", () => {
    expect(APPROVAL_HEIGHT).toBe(26);
  });
});

describe("editing in $EDITOR", () => {
  const saved = process.env.EDITOR;
  const savedVisual = process.env.VISUAL;
  afterEach(() => {
    if (saved === undefined) delete process.env.EDITOR;
    else process.env.EDITOR = saved;
    if (savedVisual === undefined) delete process.env.VISUAL;
    else process.env.VISUAL = savedVisual;
  });

  test("with no editor set it does nothing", () => {
    delete process.env.EDITOR;
    delete process.env.VISUAL;
    expect(editScriptInEditor("return 1")).toBeUndefined();
  });

  test("a failing editor does nothing", () => {
    process.env.EDITOR = "false";
    expect(editScriptInEditor("return 1")).toBeUndefined();
  });
});
