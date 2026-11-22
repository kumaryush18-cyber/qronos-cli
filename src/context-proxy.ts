// Keep a host context whole while replacing one of its methods.
//
// `{ ...ctx, executeTool }` looks harmless and is not: a spread copies own
// enumerable properties only, so anything the host keeps behind a getter on a
// prototype disappears. The host's tool context keeps `tools` that way, and the
// subagent loop then read `ctx.tools` as undefined and died with
// "ctx.tools is not iterable" before any agent had run a single tool.
//
// A proxy forwards every read to the original object — getters included — and
// answers for exactly the one property we mean to change. Methods are bound to
// the original object, because a method that touches a `#private` field rejects a
// proxy as `this` ("Cannot access invalid private field"), which is the same class
// of breakage in a different dress.
export function withToolExecutor<T extends object>(
  ctx: T,
  executeTool: (...args: never[]) => unknown,
): T {
  const bound = new Map<PropertyKey, unknown>();
  return new Proxy(ctx, {
    get(target, property, receiver) {
      if (property === "executeTool") return executeTool;
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      let cached = bound.get(property);
      if (cached === undefined) {
        cached = (value as (...args: unknown[]) => unknown).bind(target);
        bound.set(property, cached);
      }
      return cached;
    },
  });
}
