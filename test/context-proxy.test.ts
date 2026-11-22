import { describe, expect, test } from "bun:test";
import { withToolExecutor } from "../src/context-proxy";
import { ctxToolsOf } from "../src/agent-tool";

/**
 * A host context shaped the way the real harness shapes one: some fields are plain
 * own properties, and others — `tools`, the one that mattered — live behind a
 * getter on the prototype.
 */
class HostContext {
  cwd = "/tmp/project";
  #executeCalls: string[] = [];

  get tools(): Array<{ name: string }> {
    return [{ name: "read" }, { name: "write" }];
  }

  async executeTool(name: string): Promise<string> {
    this.#executeCalls.push(name);
    return `ran ${name}`;
  }

  calls(): string[] {
    return this.#executeCalls;
  }
}

describe("keeping a host context whole", () => {
  test("a field behind a prototype getter survives, which a spread would lose", () => {
    const ctx = new HostContext();
    const gated = withToolExecutor(ctx, (async () => "gated") as never);
    expect(gated.tools.map((tool) => tool.name)).toEqual(["read", "write"]);
    // The old code did this, and this is why every workflow agent failed.
    expect(({ ...ctx } as { tools?: unknown }).tools).toBeUndefined();
  });

  test("only executeTool is replaced", async () => {
    const ctx = new HostContext();
    const gated = withToolExecutor(ctx, (async () => "gated answer") as never);
    expect(await (gated as unknown as { executeTool: () => Promise<string> }).executeTool()).toBe("gated answer");
    expect(ctx.calls()).toEqual([]);
  });

  test("every other property and method still belongs to the real object", async () => {
    const ctx = new HostContext();
    const gated = withToolExecutor(ctx, (async () => "gated") as never) as unknown as HostContext;
    await ctx.executeTool("read");
    // Same own property, same prototype method, same private state: the proxy did
    // not make a copy of the host, it only answered for one name.
    expect(gated.cwd).toBe("/tmp/project");
    expect(gated.calls()).toEqual(["read"]);
  });
});

describe("reading a tool pool from a host that may not offer one", () => {
  test("a plain list is read as it is", () => {
    expect(ctxToolsOf({ tools: [{ name: "read" }] } as never)).toEqual([{ name: "read" }]);
  });

  test("getAllTools wins when both exist", () => {
    const ctx = { tools: [{ name: "old" }], getAllTools: () => [{ name: "new" }] };
    expect(ctxToolsOf(ctx as never)).toEqual([{ name: "new" }]);
  });

  test("no pool at all is an empty pool, never an exception", () => {
    // A run that dies before its first model call because a context field is
    // missing is worse than a run with fewer tools: the user sees "the workflow
    // stopped" and has nothing to act on.
    expect(ctxToolsOf({} as never)).toEqual([]);
    expect(ctxToolsOf({ tools: undefined } as never)).toEqual([]);
    expect(ctxToolsOf({ tools: "not an array" } as never)).toEqual([]);
  });

  test("an accessor that throws is an empty pool too", () => {
    const ctx = {
      get tools(): never {
        throw new Error("not a real host");
      },
    };
    expect(ctxToolsOf(ctx as never)).toEqual([]);
  });
});
