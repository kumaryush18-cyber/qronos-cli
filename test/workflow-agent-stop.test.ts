import { describe, expect, test } from "bun:test";
import { STOPPED_BY_USER, resolveStopTarget, stopProblem, stoppedNote } from "../src/workflow-agent-stop";

describe("when an agent can be stopped", () => {
  test("a live agent in a running workflow can be stopped", () => {
    expect(stopProblem({ state: "running", live: true })).toBeUndefined();
    expect(stopProblem({ state: "paused", live: true })).toBeUndefined();
    expect(stopProblem({ state: "queued", live: true })).toBeUndefined();
  });

  test("a run that settled has nothing left to stop", () => {
    expect(stopProblem({ state: "done", live: false })).toBe("that run has finished");
    expect(stopProblem({ state: "failed", live: false })).toBe("that run has finished");
    expect(stopProblem({ state: "cancelled", live: false })).toBe("that run was already stopped");
  });

  test("an agent that is not live is not stoppable", () => {
    // Two things look the same from here: it has not started, or it has already
    // finished. Both mean there is no switch to press.
    expect(stopProblem({ state: "running", live: false })).toBe("that agent is not running any more");
  });

  test("a second press says so instead of pretending", () => {
    expect(stopProblem({ state: "running", live: true, alreadyStopping: true })).toBe(
      "that agent is already stopping",
    );
  });
});

describe("how a stopped agent reads", () => {
  test("the reason is the one string the runtime uses", () => {
    expect(STOPPED_BY_USER).toBe("stopped by you");
    expect(stoppedNote(STOPPED_BY_USER)).toBe("stopped by you");
    expect(stoppedNote(undefined)).toBe("stopped by you");
  });

  test("a different reason is kept, so the report does not hide it", () => {
    expect(stoppedNote("the provider went away")).toBe("stopped: the provider went away");
  });

  test("the word failed never appears", () => {
    expect(stoppedNote(STOPPED_BY_USER)).not.toContain("failed");
  });
});

describe("which agent a word names", () => {
  const live = () => [
    { id: "#0", label: "read the tests" },
    { id: "#1", label: "read the schema" },
    { id: "#2", label: "write the report" },
  ];

  test("an id is exact", () => {
    expect(resolveStopTarget(live(), "#1")).toEqual({ id: "#1" });
    // A bare number is not an id: `1` and `#1` are different words on purpose.
    expect(resolveStopTarget(live(), "1")).toEqual({ id: "#1" });
  });

  test("a label works without the id", () => {
    expect(resolveStopTarget(live(), "write the report")).toEqual({ id: "#2" });
    expect(resolveStopTarget(live(), "WRITE THE REPORT")).toEqual({ id: "#2" });
  });

  test("part of a label works when it names exactly one agent", () => {
    expect(resolveStopTarget(live(), "report")).toEqual({ id: "#2" });
    expect(resolveStopTarget(live(), "schema")).toEqual({ id: "#1" });
  });

  test("a word that names two agents is refused with both", () => {
    const result = resolveStopTarget(live(), "read");
    expect("error" in result).toBe(true);
    const error = (result as { error: string }).error;
    expect(error).toContain("#0");
    expect(error).toContain("#1");
    expect(error).toContain("more than one");
  });

  test("a word that names nothing is refused with what is running", () => {
    const result = resolveStopTarget(live(), "deploy");
    expect("error" in result).toBe(true);
    expect((result as { error: string }).error).toContain("no running agent matches");
    expect((result as { error: string }).error).toContain("#0");
  });

  test("an empty word asks for a name instead of guessing", () => {
    expect(resolveStopTarget(live(), "   ")).toEqual({ error: "name an agent: /workflows stop <id> <agent>" });
  });

  test("a run with no live agents says so", () => {
    expect(resolveStopTarget([], "alpha")).toEqual({ error: "no agent is running in that workflow" });
  });
});
