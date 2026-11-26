import { afterEach, describe, expect, test } from "bun:test";
import { resolveQronosScope } from "../src/provider-lock";
import { FUSION_PICKER_ID as FUSION_ID } from "../src/fusion";

const QRONOS_MODEL = { provider: "qronos", id: "deepseek/deepseek-v4-flash" };

// Fake ModelRuntime.getModel: returns the qronos model, undefined for anything else.
function finder() {
  return {
    getModel: (provider: string, id: string) =>
      provider === QRONOS_MODEL.provider && id === QRONOS_MODEL.id ? (QRONOS_MODEL as never) : undefined,
  };
}

afterEach(() => {
  delete process.env.QRONOS_KEEP_ENV_PROVIDERS;
});

describe("resolveQronosScope", () => {
  test("includes registered Fusion once, without exposing other providers", () => {
    const fusion = { provider: "qronos", id: FUSION_ID };
    const runtime = { getModel: (provider: string, id: string) =>
      provider === "qronos" && id === FUSION_ID ? fusion as never : finder().getModel(provider, id) };
    expect(resolveQronosScope(runtime, "qronos", [QRONOS_MODEL.id, FUSION_ID], {}))
      .toEqual([{ model: fusion as never }, { model: QRONOS_MODEL as never }]);
    expect(resolveQronosScope(runtime, "qronos", [QRONOS_MODEL.id], { QRONOS_KEEP_ENV_PROVIDERS: "1" }))
      .toEqual([]);
  });

  test("scopes the picker to just the qronos model", () => {
    const scope = resolveQronosScope(finder(), "qronos", ["deepseek/deepseek-v4-flash"], {});
    expect(scope).toEqual([{ model: QRONOS_MODEL as never }]);
  });

  test("QRONOS_KEEP_ENV_PROVIDERS opts out — empty scope means the picker shows everything", () => {
    const scope = resolveQronosScope(finder(), "qronos", ["deepseek/deepseek-v4-flash"], {
      QRONOS_KEEP_ENV_PROVIDERS: "1",
    });
    expect(scope).toEqual([]);
  });

  test("fails open (empty scope) if the qronos model isn't registered yet", () => {
    const scope = resolveQronosScope(finder(), "qronos", ["some-other-model"], {});
    expect(scope).toEqual([]);
  });

  test("defaults to process.env when no env is passed", () => {
    process.env.QRONOS_KEEP_ENV_PROVIDERS = "1";
    expect(resolveQronosScope(finder(), "qronos", ["deepseek/deepseek-v4-flash"])).toEqual([]);
  });
});

describe("resolveQronosScope with an owned provider", () => {
  test("the free models come after the gateway models, so the default stays the same", () => {
    const runtime = {
      getModel: (provider: string, id: string) =>
        provider === "free" && id === "particle"
          ? ({ provider: "free", id: "particle" } as never)
          : finder().getModel(provider, id),
    };
    const scope = resolveQronosScope(runtime, "qronos", [QRONOS_MODEL.id], {}, [
      { provider: "free", ids: ["particle", "glm-5.3-flash"] },
    ]);
    expect(scope.map((entry) => `${entry.model.provider}/${entry.model.id}`)).toEqual([
      "qronos/deepseek/deepseek-v4-flash",
      "free/particle",
    ]);
  });

  test("an id the runtime does not know is left out, never a broken picker entry", () => {
    const scope = resolveQronosScope(finder(), "qronos", [QRONOS_MODEL.id], {}, [
      { provider: "free", ids: ["particle"] },
    ]);
    expect(scope).toHaveLength(1);
  });

  test("the same model is never listed twice", () => {
    const runtime = { getModel: (provider: string, id: string) => ({ provider, id }) as never };
    const scope = resolveQronosScope(runtime, "qronos", ["m1"], {}, [
      { provider: "qronos", ids: ["m1"] },
    ]);
    expect(scope.filter((entry) => entry.model.id === "m1")).toHaveLength(1);
  });

  test("the opt-out still wins, so a user can hide everything", () => {
    const runtime = { getModel: (provider: string, id: string) => ({ provider, id }) as never };
    expect(
      resolveQronosScope(runtime, "qronos", ["m1"], { QRONOS_KEEP_ENV_PROVIDERS: "1" }, [
        { provider: "free", ids: ["particle"] },
      ]),
    ).toEqual([]);
  });
});
