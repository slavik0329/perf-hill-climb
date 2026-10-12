import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderHtml } from "./dashboard.ts";
import { beforeValues, dataScript, parseHistory, readHistory, syncDashboard } from "./history.ts";

const HISTORY = join(import.meta.dir, "history.ts");
const DASHBOARD = join(import.meta.dir, "dashboard.ts");
const dir = mkdtempSync(join(tmpdir(), "history-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const run = (script: string, args: string[], input?: string, cwd = dir) =>
  spawnSync("bun", [script, ...args], { cwd, input, encoding: "utf8" });

describe("parseHistory", () => {
  test("accepts the four kinds and rejects malformed lines with their line number", () => {
    const ok = [
      '{"t":"2026-10-01T00:00:00Z","kind":"field","key":"a","value":1}',
      "",
      '{"t":"2026-10-02T00:00:00Z","kind":"event","label":"1.0 released","type":"release"}',
    ].join("\n");
    expect(parseHistory(ok)).toHaveLength(2);
    expect(() => parseHistory("{nope")).toThrow("line 1: not JSON");
    expect(() => parseHistory('{"t":"x","kind":"field","key":"a","value":1}')).toThrow("line 1");
    expect(() => parseHistory('{"t":"2026-10-01","kind":"lab","key":"a"}')).toThrow('numeric "value"');
    expect(() => parseHistory('{"t":"2026-10-01","kind":"event"}')).toThrow('"label"');
  });
});

describe("beforeValues", () => {
  test("reads only the documented `# <before>: <why>` form", () => {
    const text = [
      "a.blocked_ms     0   # 1000: readString waited at EOF",
      "b.blocked_ms  2400   # 1500 fast timeout + 100 scan + 800 connect",
      "c.attempts      13   # 17: 4 fast + 13 scan",
      "# d.commented   1   # 5: ignored",
      "e.plain          1",
    ].join("\n");
    expect([...beforeValues(text)]).toEqual([["a.blocked_ms", 1000], ["c.attempts", 17]]);
  });
});

describe("history.ts CLI", () => {
  const h = join(dir, "perf-history.jsonl");
  const budget = join(dir, "perf-budget.txt");

  test("field records one entry per key with its metadata", () => {
    const r = run(HISTORY, ["field", h, "-", "--version", "1.2", "--stat", "p95", "--unit", "ms", "--n", "480", "--source", "estimate", "--note", "first", "--t", "2026-10-01T12:00:00Z"], "api.get 410\napi.list 95\n");
    expect(r.status).toBe(0);
    expect(readHistory(h)).toEqual([
      { t: "2026-10-01T12:00:00.000Z", kind: "field", key: "api.get", value: 410, stat: "p95", unit: "ms", n: 480, version: "1.2", source: "estimate", note: "first" },
      { t: "2026-10-01T12:00:00.000Z", kind: "field", key: "api.list", value: 95, stat: "p95", unit: "ms", n: 480, version: "1.2", source: "estimate", note: "first" },
    ]);
  });

  test("lab records ceilings and counts only when they change", () => {
    writeFileSync(budget, "api.get.queries  3  # 12: N+1\napi.get.blocked_ms  500\n");
    const log = "BUDGET api.get.queries 3 / 3\nBUDGET api.get.blocked_ms 450 / 500  (lower the ceiling)\n";
    const before = readHistory(h).length;
    expect(run(HISTORY, ["lab", h, budget, "-"], log).stdout).toContain("4 entries added");
    expect(run(HISTORY, ["lab", h, budget, "-"], log).stdout).toContain("0 entries added");
    writeFileSync(budget, "api.get.queries  2  # 12: N+1\napi.get.blocked_ms  450\n");
    run(HISTORY, ["lab", h, budget, "-"], "BUDGET api.get.queries 2 / 2\nBUDGET api.get.blocked_ms 450 / 450\n");
    const added = readHistory(h).slice(before).map((e) => [e.kind, e.key, e.value]);
    expect(added).toEqual([
      ["ceiling", "api.get.queries", 3], ["ceiling", "api.get.blocked_ms", 500],
      ["lab", "api.get.queries", 3], ["lab", "api.get.blocked_ms", 450],
      ["ceiling", "api.get.queries", 2], ["ceiling", "api.get.blocked_ms", 450],
      ["lab", "api.get.queries", 2],
    ]);
  });

  test("event records a labelled marker", () => {
    run(HISTORY, ["event", h, "1.3 released", "--type", "release", "--version", "1.3"]);
    const e = readHistory(h).at(-1)!;
    expect([e.kind, e.label, e.type, e.version]).toEqual(["event", "1.3 released", "release", "1.3"]);
  });

  test("usage errors exit 2", () => {
    expect(run(HISTORY, ["field", h]).status).toBe(2);
    expect(run(HISTORY, ["nope", h]).status).toBe(2);
    const bad = run(HISTORY, ["event", h, "x", "--t", "yesterday-ish"]);
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain("--t must be an ISO date");
  });
});

describe("backfill", () => {
  test("records each ceiling change from git, with before values from comments, once", () => {
    const repo = mkdtempSync(join(dir, "repo-"));
    const git = (...args: string[]) =>
      spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: repo, encoding: "utf8" });
    git("init", "-q", "-b", "main");
    writeFileSync(join(repo, "budget.txt"), "a.ms  900   # 1000: slow read\nb.count  4\n");
    git("add", ".");
    git("commit", "-q", "-m", "one");
    writeFileSync(join(repo, "budget.txt"), "a.ms  0   # 1000: slow read\nb.count  4\nc.count  1  # 2: exists then open\n");
    git("commit", "-q", "-am", "two");

    const hist = join(repo, "perf-history.jsonl");
    expect(run(HISTORY, ["backfill", hist, join(repo, "budget.txt")], undefined, repo).status).toBe(0);
    const got = readHistory(hist).map((e) => [e.kind, e.key, e.value, e.stat ?? ""]);
    expect(got).toEqual([
      ["lab", "a.ms", 1000, "before"], ["ceiling", "a.ms", 900, ""], ["ceiling", "b.count", 4, ""],
      ["ceiling", "a.ms", 0, ""], ["lab", "c.count", 2, "before"], ["ceiling", "c.count", 1, ""],
    ]);
    run(HISTORY, ["backfill", hist, join(repo, "budget.txt")], undefined, repo);
    expect(readHistory(hist)).toHaveLength(6);

    // A before value is not "the last lab count": the first real count is still recorded.
    writeFileSync(join(repo, "budget.txt"), "a.ms  0\nb.count  4\nc.count  1\n");
    run(HISTORY, ["lab", hist, join(repo, "budget.txt"), "-"], "c.count 2\n", repo);
    expect(readHistory(hist).at(-1)).toMatchObject({ kind: "lab", key: "c.count", value: 2 });
    expect(readHistory(hist).at(-1)!.stat).toBeUndefined();
  });
});

describe("dashboard data and page", () => {
  test("the data file is JS that hands the entries to the page, with < escaped", () => {
    const text = '{"t":"2026-10-01T00:00:00Z","kind":"event","label":"</script><b>x"}\n';
    const js = dataScript(text);
    expect(js).not.toContain("</script>");
    let got: { stamp: string; entries: unknown[] } | undefined;
    new Function("window", js)({ perfDashboard: (p: typeof got) => (got = p) });
    expect(got!.entries).toEqual([{ t: "2026-10-01T00:00:00Z", kind: "event", label: "</script><b>x" }]);
    expect(got!.stamp).toMatch(/^[0-9a-f]{12}$/);
    const stamp = (t: string) => dataScript(t).match(/"stamp":"(\w+)"/)![1];
    expect(stamp(text)).toBe(got!.stamp); // same history, same stamp: the page doesn't redraw
    expect(stamp(text + text)).not.toBe(got!.stamp); // any change redraws
  });

  test("history writes refresh the data file only once a dashboard exists", () => {
    const d = mkdtempSync(join(dir, "dash-"));
    const hist = join(d, "perf-history.jsonl");
    run(HISTORY, ["event", hist, "start"], undefined, d);
    expect(existsSync(join(d, "perf-dashboard.data.js"))).toBe(false);

    const r = run(DASHBOARD, [hist, "--title", 'Tom & "Jerry" <api>'], undefined, d);
    expect(r.status).toBe(0);
    const html = readFileSync(join(d, "perf-dashboard.html"), "utf8");
    expect(html).toContain("<title>Tom &amp; &quot;Jerry&quot; &lt;api&gt;</title>");
    expect(html).toContain('const TITLE = "Tom & \\"Jerry\\" \\u003capi>";');
    expect(html).not.toContain("__TITLE_");

    run(HISTORY, ["event", hist, "second"], undefined, d);
    expect(readFileSync(join(d, "perf-dashboard.data.js"), "utf8")).toContain('"label":"second"');
    expect(syncDashboard(join(dir, "nowhere", "perf-history.jsonl"))).toBe(false);
  });

  test("the page script compiles", () => {
    const html = renderHtml("x");
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    expect(scripts).toHaveLength(1);
    expect(() => new Function(scripts[0])).not.toThrow();
    expect(html).toContain('<script src="perf-dashboard.data.js"></script>');
  });
});
