// Tests for the copyable harness in assets/harness/.
import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock, counted } from "../assets/harness/fakes.ts";

const HARNESS = join(import.meta.dir, "..", "assets", "harness");
const dir = mkdtempSync(join(tmpdir(), "harness-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const BUDGET = "api.get.queries   2   # 1 + N before\napi.get.blocked_ms  500\n";
writeFileSync(join(dir, "budget.txt"), BUDGET);

describe("budget.ts", () => {
  test("prints BUDGET lines and fails on over or missing", async () => {
    process.env.PERF_BUDGET_FILE = join(dir, "budget.txt");
    const { budget, budgetFailures } = await import("../assets/harness/budget.ts");
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(budget("api.get.queries", 2)).toBe(true);
      expect(budget("api.get.blocked_ms", 200)).toBe(true);
      expect(budget("api.get.queries", 3)).toBe(false);
      expect(budget("api.new.thing", 1)).toBe(false);
      expect(budgetFailures()).toBe(2);
      const lines = log.mock.calls.map((c) => String(c[0]));
      expect(lines[1]).toEndWith("200 / 500  (lower the ceiling)");
      expect(lines[2]).toEndWith("3 / 2  OVER");
      expect(lines[3]).toContain("MISSING from");
    } finally {
      log.mockRestore();
    }
  });
});

describe("fakes.ts", () => {
  test("FakeClock counts what the code would have waited, instantly", async () => {
    const clock = new FakeClock();
    const retry = async (attempts: number) => {
      for (let i = 0; i < attempts; i++) await clock.sleep(200 * 2 ** i);
    };
    const started = performance.now();
    await retry(3);
    clock.advance(50);
    expect(clock.blockedMs).toBe(1400);
    expect(clock.now()).toBe(1450);
    expect(clock.sleeps).toBe(3);
    expect(performance.now() - started).toBeLessThan(100);
  });

  test("counted() counts calls by name and keeps behaviour and this", async () => {
    const db = {
      rows: [1, 2, 3],
      query(i: number) {
        return this.rows[i];
      },
      async close() {
        return "closed";
      },
    };
    const { proxy, counts } = counted(db);
    expect(proxy.query(1)).toBe(2);
    proxy.query(2);
    expect(await proxy.close()).toBe("closed");
    expect(proxy.rows).toEqual([1, 2, 3]);
    expect(Object.fromEntries(counts)).toEqual({ query: 2, close: 1 });
  });
});

const cxx = spawnSync("c++", ["--version"]).status === 0;

describe("budget.h + fake_clock.h", () => {
  test.skipIf(!cxx)("compile clean under sanitizers and feed ratchet.ts check", () => {
    writeFileSync(
      join(dir, "wake_test.cpp"),
      `#include "fake_clock.h"
#include "budget.h"
// Code under test: retries a connect, waiting between attempts.
static int connectWithRetry(int failures) {
    int attempts = 0;
    for (;;) {
        ++attempts;
        if (failures-- <= 0) return attempts;
        delay(200);
    }
}
int main() {
    fake::reset();
    const int attempts = connectWithRetry(2);
    fake::advance(30);
    Budget::check("api.get.blocked_ms", static_cast<long>(fake::blockedMs));
    Budget::check("api.get.queries", attempts);
    return Budget::result();
}
`,
    );
    const build = spawnSync(
      "c++",
      ["-std=c++17", "-Wall", "-Wextra", "-Werror", "-fsanitize=address,undefined", "-I", HARNESS, "wake_test.cpp", "-o", "wake_test"],
      { cwd: dir, encoding: "utf8" },
    );
    expect(build.stderr).toBe("");
    expect(build.status).toBe(0);

    const runTest = spawnSync("./wake_test", [], { cwd: dir, encoding: "utf8", env: { ...process.env, PERF_BUDGET_FILE: "budget.txt" } });
    expect(runTest.stdout).toContain("api.get.blocked_ms                    400 / 500  (lower the ceiling)");
    expect(runTest.stdout).toContain("3 / 2  OVER");
    expect(runTest.status).toBe(1);

    const check = spawnSync("bun", [join(import.meta.dir, "ratchet.ts"), "check", "budget.txt", "-"], {
      cwd: dir,
      input: runTest.stdout,
      encoding: "utf8",
    });
    expect(check.status).toBe(1);
    expect(check.stdout).toContain("FAIL: 1 budget(s) exceeded or missing");
  });
});
