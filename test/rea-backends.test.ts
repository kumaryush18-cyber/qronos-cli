import { describe, expect, test } from "bun:test";
import { detectReaBackends, summarizeReaBackends } from "../src/rea-backends";

/** A machine with nothing installed: every external backend is missing. */
function bareMachine(env: Record<string, string> = {}, present: string[] = []) {
  return detectReaBackends({
    env,
    platform: "linux",
    hasCommand: (command) => present.includes(command),
    hasPath: (path) => present.includes(path),
  });
}

const byName = (list: ReturnType<typeof detectReaBackends>, name: string) => list.find((b) => b.name === name)!;

describe("REA backend readiness", () => {
  test("file identification is always ready: it needs no external program", () => {
    const backends = bareMachine();
    expect(byName(backends, "file id").ok).toBe(true);
    expect(byName(backends, "file id").hint).toBe("");
  });

  test("pwntools needs REA_PWNTOOLS_PYTHON pointing at a real file", () => {
    expect(byName(bareMachine(), "pwntools").ok).toBe(false);
    expect(byName(bareMachine({ REA_PWNTOOLS_PYTHON: "/opt/pw/bin/python" }), "pwntools").ok).toBe(
      false,
    );
    const withPython = bareMachine({ REA_PWNTOOLS_PYTHON: "/opt/pw/bin/python" }, [
      "/opt/pw/bin/python",
    ]);
    expect(byName(withPython, "pwntools").ok).toBe(true);
    expect(byName(withPython, "pwntools").hint).toContain("pyelftools");
  });

  test("jeb needs an endpoint, because the default port may be closed", () => {
    expect(byName(bareMachine(), "jeb").ok).toBe(false);
    const withJeb = bareMachine({ REA_JEB_MCP_URL: "http://127.0.0.1:8425/mcp" });
    expect(byName(withJeb, "jeb").ok).toBe(true);
    expect(byName(bareMachine(), "jeb").hint).toContain("8425");
  });

  test("hopper counts only on macOS, and only when the app bundle is there", () => {
    const darwin = detectReaBackends({
      env: {},
      platform: "darwin",
      hasCommand: () => false,
      hasPath: (path) => path === "/Applications/Hopper Disassembler.app",
    });
    expect(byName(darwin, "hopper").ok).toBe(true);
    expect(byName(bareMachine(), "hopper").ok).toBe(false);
    expect(byName(bareMachine(), "hopper").hint).toContain("macOS");
  });

  test("PATH programs are reported one by one", () => {
    const backends = bareMachine({}, ["tshark", "adb"]);
    expect(byName(backends, "tshark").ok).toBe(true);
    expect(byName(backends, "adb").ok).toBe(true);
    expect(byName(backends, "apktool").ok).toBe(false);
    expect(byName(backends, "frida").ok).toBe(false);
  });
});

describe("REA backend summary line", () => {
  test("names what is ready and what is missing, with hints", () => {
    const line = summarizeReaBackends(bareMachine({}, ["tshark"]));
    expect(line).toContain("ready: file id, tshark");
    expect(line).toContain("missing:");
    expect(line).toContain("jeb");
    expect(line).toContain("8425"); // the hint is shown, not just the name
  });

  test("stays short: at most three hints, then a count", () => {
    const line = summarizeReaBackends(bareMachine());
    const hintCount = line.split(";").length;
    expect(hintCount).toBeGreaterThan(1);
    expect(line).toContain("more");
  });

  test("says so when everything is present", () => {
    const all = detectReaBackends({
      env: { REA_PWNTOOLS_PYTHON: "/pw/python", REA_JEB_MCP_URL: "http://x" },
      // darwin, because Hopper exists only there: on linux it is always missing.
      platform: "darwin",
      hasCommand: () => true,
      hasPath: () => true,
    });
    expect(summarizeReaBackends(all)).toContain("every backend found");
  });
});
