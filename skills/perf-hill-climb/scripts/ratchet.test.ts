import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { check, formatRow, guard, lower, parseBudget, parseMeasured } from "./ratchet.ts";

const BUDGET = `# header comment
# key                         ceiling   # before
data.load.blocked_ms                0   # 1000: readString at EOF
wifi.fallback.blocked_ms         2400   # 1500 + 100 + 800
lint.readString                     0
`;

const SCRIPT = join(import.meta.dir, "ratchet.ts");
const run = (args: string[], cwd: string, input?: string) =>
  spawnSync("bun", [SCRIPT, ...args], { cwd, input, encoding: "utf8" });

describe("parseBudget", () => {
  test("reads keys and ceilings, ignoring comments", () => {
    expect([...parseBudget(BUDGET)]).toEqual([
      ["data.load.blocked_ms", 0],
      ["wifi.fallback.blocked_ms", 2400],
      ["lint.readString", 0],
    ]);
  });
  test("rejects duplicates and non-numeric ceilings", () => {
    expect(() => parseBudget("a 1\na 2\n")).toThrow("duplicate key a");
    expect(() => parseBudget("a lots\n")).toThrow("not a number");
  });
});

describe("parseMeasured", () => {
  test("JSON, with nested keys joined by dots", () => {
    expect([...parseMeasured('{"a": 1, "b": {"c": 2, "d": "x"}}')]).toEqual([["a", 1], ["b.c", 2]]);
  });
  test("plain key value lines", () => {
    expect([...parseMeasured("a 1\nb 2.5 # note\n\n")]).toEqual([["a", 1], ["b", 2.5]]);
  });
  test("only BUDGET lines when a test log contains them", () => {
    const log = "Running 12 tests\nBUDGET a 5 / 3  OVER\nBUDGET b 1 / 4  (lower the ceiling)\nFAIL: 1 budget(s) exceeded\n";
    expect([...parseMeasured(log)]).toEqual([["a", 5], ["b", 1]]);
  });
  test("a key measured twice keeps its worst value", () => {
    expect(parseMeasured("a 3\na 7\na 5\n").get("a")).toBe(7);
  });
});

describe("check", () => {
  const budget = parseBudget(BUDGET);
  test("ok, lower, over, missing and unmeasured", () => {
    const rows = check(budget, parseMeasured("data.load.blocked_ms 0\nwifi.fallback.blocked_ms 2150\nlint.readString 1\nnew.key 9\n"));
    expect(rows.map((r) => [r.key, r.status])).toEqual([
      ["data.load.blocked_ms", "ok"],
      ["wifi.fallback.blocked_ms", "lower"],
      ["lint.readString", "over"],
      ["new.key", "missing"],
    ]);
    expect(check(budget, parseMeasured("lint.readString 0\n")).filter((r) => r.status === "unmeasured")).toHaveLength(2);
  });
  test("prints the harness's line format", () => {
    expect(formatRow({ key: "a", measured: 5, ceiling: 3, status: "over" })).toBe(`BUDGET ${"a".padEnd(34)}      5 / 3  OVER`);
    expect(formatRow({ key: "a", measured: 1, ceiling: 3, status: "lower" })).toEndWith("1 / 3  (lower the ceiling)");
    expect(formatRow({ key: "a", measured: 1, status: "missing" })).toEndWith("MISSING from budget file");
  });
  test("CLI exits 1 on over or missing, 0 otherwise", () => {
    const dir = mkdtempSync(join(tmpdir(), "ratchet-"));
    try {
      writeFileSync(join(dir, "budget.txt"), BUDGET);
      expect(run(["check", "budget.txt", "-"], dir, "lint.readString 1\n").status).toBe(1);
      expect(run(["check", "budget.txt", "-"], dir, "nope 1\n").status).toBe(1);
      const ok = run(["check", "budget.txt", "-"], dir, "wifi.fallback.blocked_ms 2000\n");
      expect(ok.status).toBe(0);
      expect(ok.stdout).toContain("1 ceiling(s) can be lowered");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("lower", () => {
  test("lowers in place, keeps comments and alignment, never raises", () => {
    const { text, changes } = lower(BUDGET, parseMeasured("wifi.fallback.blocked_ms 950\ndata.load.blocked_ms 4\nunknown 1\n"));
    expect(changes).toEqual([{ key: "wifi.fallback.blocked_ms", from: 2400, to: 950 }]);
    expect(text).toContain("wifi.fallback.blocked_ms          950   # 1500 + 100 + 800");
    expect(text).toContain("data.load.blocked_ms                0   # 1000: readString at EOF");
    expect(text.split("\n")[0]).toBe("# header comment");
    expect(text.split("\n").length).toBe(BUDGET.split("\n").length);
  });
  test("leaves commented-out lines alone", () => {
    expect(lower("# a 10\na 10\n", parseMeasured("a 3\n")).text).toBe("# a 10\na  3\n");
  });
});

describe("guard", () => {
  test("flags raised and removed keys, allows new and lowered ones", () => {
    const problems = guard(parseBudget("a 5\nb 5\nc 5\n"), parseBudget("a 6\nc 1\nd 100\n"));
    expect(problems).toEqual(["RATCHET a: raised 5 -> 6", "RATCHET b: removed (was 5)"]);
  });

  test("CLI against a git base ref", () => {
    const dir = mkdtempSync(join(tmpdir(), "ratchet-"));
    const git = (...args: string[]) =>
      spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf8" });
    try {
      git("init", "-q", "-b", "main");
      writeFileSync(join(dir, "README"), "x\n");
      git("add", ".");
      git("commit", "-q", "-m", "first");

      writeFileSync(join(dir, "budget.txt"), BUDGET);
      const skippedNow = run(["guard", "budget.txt", "main"], dir);
      expect(skippedNow.status).toBe(0);
      expect(skippedNow.stdout).toContain("does not exist on main yet");

      git("add", ".");
      git("commit", "-q", "-m", "budget");
      expect(run(["guard", "budget.txt", "no-such-ref"], dir).stdout).toContain("skipped: no-such-ref not found");
      expect(run(["guard", "budget.txt", "main"], dir).stdout).toContain("RATCHET ok");

      writeFileSync(join(dir, "budget.txt"), BUDGET.replace("2400", "2500").replace("lint.readString                     0\n", ""));
      const bad = run(["guard", "budget.txt", "main"], dir);
      expect(bad.status).toBe(1);
      expect(bad.stdout).toContain("RATCHET wifi.fallback.blocked_ms: raised 2400 -> 2500");
      expect(bad.stdout).toContain("RATCHET lint.readString: removed (was 0)");

      writeFileSync(join(dir, "budget.txt"), BUDGET);
      run(["lower", "budget.txt", "-"], dir, "wifi.fallback.blocked_ms 900\n");
      expect(readFileSync(join(dir, "budget.txt"), "utf8")).toContain("wifi.fallback.blocked_ms          900");
      expect(run(["guard", "budget.txt", "main"], dir).status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
