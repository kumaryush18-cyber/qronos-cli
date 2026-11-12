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
