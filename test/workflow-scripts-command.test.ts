import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkflowToolExtension } from "../src/workflow-tool";
import { workflowConfigFromEnv } from "../src/workflow-types";

/** Three agents in the text, so the approval card is part of the path. */
const THREE = `export const meta = { name: "review", description: "three looks", phases: [{ title: "Look", agents: 3 }] };
phase("Look");
for (const task of ["a", "b", "c"]) {
  await agent("look at " + task, { label: task });
}
return "done";`;

let project = "";
let realCwd = "";

beforeEach(() => {
  realCwd = process.cwd();
  project = mkdtempSync(join(tmpdir(), "qronos-scripts-"));
  mkdirSync(join(project, ".qronos", "workflows"), { recursive: true });
  writeFileSync(join(project, ".qronos", "workflows", "review.js"), THREE);
  process.chdir(project);
});

afterEach(() => {
  process.chdir(realCwd);
});

/** The command handler, with a fake host that can show a card. */
function host(keys: string[][]) {
  const notices: string[] = [];
  const cards: string[] = [];
  const asked: string[] = [];
  let index = 0;
  const commands: Array<(args: string, ctx: unknown) => Promise<void>> = [];
  const tools: Array<Record<string, unknown>> = [];
  // The union type has no `.factory`, so the cast is the seam the other tests use.
  const extension = createWorkflowToolExtension({ config: { ...workflowConfigFromEnv({}), concurrency: 1 }, agentDir: join(project, "agent") }) as unknown as {
    factory: (api: unknown) => void;
  };
  extension.factory({
    registerTool: (tool: Record<string, any>) => tools.push(tool),
    registerCommand: (_name: string, spec: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.push(spec.handler),
    registerShortcut: () => {},
    sendMessage: () => {},
    sendUserMessage: (text: string) => asked.push(text),
    on: () => {},
  } as never);

  const ui = {
    ui: {
      notify: (text: string) => notices.push(text),
      setStatus: () => {},
      custom: async (build: any) => {
        const pressed = keys[index] ?? [];
        index += 1;
        const component = build({ requestRender: () => {} }, { fg: (_slot: string, text: string) => text }, {}, () => {});
        cards.push(component.render(66).map((line: string) => line.replace(/\u001b\[[0-9;]*m/g, "")).join("\n"));
        for (const key of pressed) component.handleInput(key);
      },
    },
  };

  const send = async (args: string): Promise<string> => {
    notices.length = 0;
    await commands[0]!(args, ui);
    return notices.join("\n");
  };
  return { send, cards, asked };
}

describe("/workflows scripts", () => {
  test("it lists what is saved, with the way to use it", async () => {
    const { send } = host([]);
    const shown = await send("scripts");
    expect(shown).toContain("review");
    expect(shown).toContain("/workflows run <name>");
    expect(shown).toContain("/workflows edit <name>");
  });

  test("an empty project says so instead of showing nothing", async () => {
    rmSync(join(project, ".qronos", "workflows", "review.js"));
    const { send } = host([]);
    const shown = await send("scripts");
    expect(shown).toContain("No scripts saved in this project yet");
  });
});

describe("/workflows run", () => {
  test("a name that is not there lists the ones that are", async () => {
    const { send } = host([]);
    const shown = await send("run deploy");
    expect(shown).toContain('No saved script called "deploy"');
    expect(shown).toContain("Saved: review");
  });

  test("no name asks for one", async () => {
    const { send } = host([]);
    expect(await send("run")).toContain("Name a saved script");
  });

  test("a good script is handed to the model, with the exact path", async () => {
    // A command cannot run tools; the model can. The message is the hand-off.
    const { send, asked } = host([]);
    const shown = await send("run review");
    expect(asked.length).toBe(1);
    expect(asked[0]).toContain(join(project, ".qronos", "workflows", "review.js"));
    expect(asked[0]).toContain("scriptFile");
    expect(shown).toContain("Starting review");
    expect(shown).toContain("nothing runs until you answer it");
  });

  test("the message tells the model not to retype the script", async () => {
    const { send, asked } = host([]);
    await send("run review");
    expect(asked[0]).toContain("do not retype");
  });

  test("an empty file is refused before any card", async () => {
    writeFileSync(join(project, ".qronos", "workflows", "empty.js"), "\n\n");
    const { send, cards } = host([]);
    const shown = await send("run empty");
    expect(shown).toContain("the file is empty");
    expect(cards.length).toBe(0);
  });

  test("a name with capitals finds the slug on disk", async () => {
    const { send, asked } = host([]);
    await send("run Review");
    expect(asked[0]).toContain("review.js");
  });
});

describe("/workflows edit", () => {
  const saved = { VISUAL: process.env.VISUAL, EDITOR: process.env.EDITOR };

  beforeEach(() => {
    delete process.env.VISUAL;
  });

  afterEach(() => {
    if (saved.EDITOR === undefined) delete process.env.EDITOR;
    else process.env.EDITOR = saved.EDITOR;
    if (saved.VISUAL === undefined) delete process.env.VISUAL;
    else process.env.VISUAL = saved.VISUAL;
  });

  const fakeEditor = (body: string): string => {
    const dir = mkdtempSync(join(tmpdir(), "qronos-edit-cmd-"));
    const file = join(dir, "editor.sh");
    writeFileSync(file, `#!/bin/sh\n${body}\n`, "utf8");
    chmodSync(file, 0o755);
    return file;
  };

  test("no editor means nothing is changed", async () => {
    delete process.env.EDITOR;
    const { send, cards } = host([]);
    expect(await send("edit review")).toContain("Nothing changed");
    expect(readFileSync(join(project, ".qronos", "workflows", "review.js"), "utf8")).toBe(THREE);
    expect(cards.length).toBe(0);
  });

  test("an edited file is only written when the card is answered yes", async () => {
    process.env.EDITOR = fakeEditor('printf "// changed\\n%s" "$(cat \\"$1\\")" > "$1"');
    const { send, cards } = host([["y"]]);
    const shown = await send("edit review");
    expect(cards[0]).toContain("Save the change?");
    expect(cards[0]).toContain(".qronos/workflows/review.js");
    expect(shown).toContain("Saved");
    expect(readFileSync(join(project, ".qronos", "workflows", "review.js"), "utf8")).toStartWith("// changed");
  });

  test("a no leaves the file exactly as it was", async () => {
    process.env.EDITOR = fakeEditor('printf "// changed\\n%s" "$(cat \\"$1\\")" > "$1"');
    const { send } = host([["\u001b"]]);
    const shown = await send("edit review");
    expect(shown).toContain("Not saved");
    expect(readFileSync(join(project, ".qronos", "workflows", "review.js"), "utf8")).toBe(THREE);
  });

  test("a missing name is a message, not a card", async () => {
    process.env.EDITOR = fakeEditor("true");
    const { send, cards } = host([]);
    expect(await send("edit nothing-here")).toContain("No saved script called");
    expect(cards.length).toBe(0);
  });
});
