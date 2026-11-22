import { describe, expect, test } from "bun:test";
import { KEYWORD_SECTIONS, ORCHESTRATE_NOTICE, ULTRACODE_NOTICE, WORKFLOW_HELPERS, orchestrateSection, ultracodeSection } from "../src/workflow-notice";
import { ORCHESTRATE_SECTION, ULTRACODE_SECTION } from "../src/ultrathink";
import { createUltrathinkExtension } from "../src/ultrathink-extension";

describe("the ultracode notice", () => {
  test("names only helpers the sandbox really has", () => {
    for (const helper of WORKFLOW_HELPERS) {
      expect(ULTRACODE_NOTICE).toContain(`${helper}(`);
    }
  });

  test("does not promise a helper that does not exist", () => {
    for (const phantom of ["workpool(", "judge(", "completion(", "judgeBatch("]) {
      expect(ULTRACODE_NOTICE).not.toContain(phantom);
    }
  });

  test("states the real limits", () => {
    expect(ULTRACODE_NOTICE).toContain("10 minutes");
    expect(ULTRACODE_NOTICE).toContain("1000 agents");
    expect(ULTRACODE_NOTICE).toContain("16 at a time");
  });

  test("forbids imports and the filesystem", () => {
    expect(ULTRACODE_NOTICE).toContain("No imports");
    expect(ULTRACODE_NOTICE).toContain("no filesystem");
  });

  test("tells the model to return a small value", () => {
    expect(ULTRACODE_NOTICE).toContain("small value");
  });

  test("the section has a heading", () => {
    expect(ultracodeSection()).toContain("## Ultracode workflow (this turn)");
  });
});

describe("the orchestrate notice", () => {
  test("points at the agent tool for small jobs", () => {
    expect(ORCHESTRATE_NOTICE).toContain("`agent`");
  });

  test("points at the workflow tool for large jobs", () => {
    expect(ORCHESTRATE_NOTICE).toContain("`workflow`");
  });

  test("the section has a heading", () => {
    expect(orchestrateSection()).toContain("## Orchestrate (this turn)");
  });
});

describe("the keyword map", () => {
  test("ultracode and orchestrate each have a section", () => {
    expect(Object.keys(KEYWORD_SECTIONS).sort()).toEqual(["orchestrate", "ultracode"]);
    expect(KEYWORD_SECTIONS.ultracode?.section).toBe(ULTRACODE_SECTION);
    expect(KEYWORD_SECTIONS.orchestrate?.section).toBe(ORCHESTRATE_SECTION);
  });

  test("ultrathink is not in the map: it has its own section already", () => {
    expect(KEYWORD_SECTIONS.ultrathink).toBeUndefined();
  });
});

describe("the extension wiring", () => {
  function harness() {
    const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
    const api = { on: (name: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => handlers.set(name, handler) };
    (createUltrathinkExtension() as unknown as { factory: (api: unknown) => void }).factory(api);
    return handlers;
  }

  const fakeCtx = { ui: { setEditorComponent: () => {}, setStatus: () => {} } } as never;

  async function sectionsFor(prompt: string) {
    const sections: Record<string, string> = {};
    await harness().get("before_agent_start")!({ prompt, systemPromptOptions: { sections } }, fakeCtx);
    return sections;
  }

  test("ultracode adds its section and nothing else", async () => {
    const sections = await sectionsFor("ultracode audit every route");
    expect(sections[ULTRACODE_SECTION]).toContain("multi-agent workflow");
    expect(sections[ORCHESTRATE_SECTION]).toBeUndefined();
    expect(sections["qronos-ultrathink"]).toBeUndefined();
  });

  test("orchestrate adds its section", async () => {
    const sections = await sectionsFor("orchestrate the migration");
    expect(sections[ORCHESTRATE_SECTION]).toContain("independent");
  });

  test("a plain prompt adds no section at all", async () => {
    const sections = await sectionsFor("fix the bug");
    expect(Object.keys(sections)).toEqual([]);
  });

  test("the word inside a code span does not add a section", async () => {
    const sections = await sectionsFor("run `ultracode` later");
    expect(sections[ULTRACODE_SECTION]).toBeUndefined();
  });

  test("the word inside a path does not add a section", async () => {
    const sections = await sectionsFor("read src/ultracode.ts");
    expect(sections[ULTRACODE_SECTION]).toBeUndefined();
  });
});
