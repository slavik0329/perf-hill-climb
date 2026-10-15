import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderHtml } from "./dashboard.ts";
import { beforeValues, dataScript, parseHistory, parseJourneys, readHistory, syncDashboard, unrecorded, type Entry } from "./history.ts";

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

describe("parseJourneys", () => {
  test("needs a key and members, and a key in one journey only", () => {
    expect(parseJourneys('[{"key":"zap","members":["zap.a","zap.b"]}]')).toEqual([{ key: "zap", members: ["zap.a", "zap.b"] }]);
    expect(() => parseJourneys("{")).toThrow("not JSON");
    expect(() => parseJourneys('{"key":"zap"}')).toThrow("array");
    expect(() => parseJourneys('[{"key":"zap","members":[]}]')).toThrow("journey 1");
    expect(() => parseJourneys('[{"key":"a","members":["x"]},{"key":"b","members":["x"]}]')).toThrow("x is in both a and b");
    expect(() => parseJourneys('[{"key":"a","members":["x"]},{"key":"x","members":["y"]}]')).toThrow("x is in both a and x");
  });
});

describe("unrecorded", () => {
  const f = (key: string, version: string, value: number, n: number, t = "2026-10-01T00:00:00.000Z", stat = "p50"): Entry =>
    ({ t, kind: "field", key, value, stat, n, version });
  const journeys = [{ key: "zap", members: ["zap.survey", "zap.total"] }];

  test("skips a statistic and version its journey already has, under any of its keys", () => {
    const history = [f("zap.survey", "1.1", 833, 26)];
    expect(unrecorded(history, journeys, [f("zap.total", "1.1", 990, 45)])).toEqual([]);
    expect(unrecorded(history, journeys, [f("zap.total", "1.2", 900, 40)])).toHaveLength(1);
    expect(unrecorded(history, journeys, [f("zap.total", "1.1", 1500, 45, undefined, "p95")])).toHaveLength(1);
    expect(unrecorded(history, [], [f("zap.total", "1.1", 990, 45)])).toHaveLength(1); // no journey: another key
  });

  test("adds a re-report of the same key, version and time once the runs grow by half", () => {
    const history = [f("zap.total", "1.2", 900, 10)];
    expect(unrecorded(history, journeys, [f("zap.total", "1.2", 910, 14)])).toEqual([]);
    expect(unrecorded(history, journeys, [f("zap.total", "1.2", 910, 15)])).toEqual([f("zap.total", "1.2", 910, 15)]);
    expect(unrecorded(history, journeys, [f("zap.total", "1.2", 910, 30, "2026-10-02T00:00:00.000Z")])).toEqual([]);
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

  test("field --once adds only what isn't recorded", () => {
    const once = (input: string) => run(HISTORY, ["field", h, "-", "--version", "1.4", "--stat", "p50", "--n", "20", "--once", "--t", "2026-10-03T00:00:00Z"], input);
    expect(once("api.get 300\n").stdout).toContain("1 entry added");
    expect(once("api.get 300\napi.list 80\n").stdout).toContain("1 entry added");
    expect(readHistory(h).slice(-2).map((e) => e.key)).toEqual(["api.get", "api.list"]);
    expect(run(HISTORY, ["field", h, "-", "--once"], "api.get 1\n").status).toBe(2); // needs --version
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

describe("hook", () => {
  test("adds sync to the git hooks once, keeps what they did, and a commit refreshes the data", () => {
    const repo = mkdtempSync(join(dir, "hook-"));
    const git = (...args: string[]) =>
      spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: repo, encoding: "utf8" });
    git("init", "-q", "-b", "main");
    const hooks = join(repo, ".git", "hooks");
    writeFileSync(join(hooks, "post-commit"), "#!/bin/sh\necho earlier hook\n");
    const perf = join(repo, "perf");
    spawnSync("mkdir", ["-p", perf]);
    const hist = join(perf, "perf-history.jsonl");
    writeFileSync(hist, "");
    writeFileSync(join(perf, "perf-dashboard.html"), "");

    expect(run(HISTORY, ["hook", "perf/perf-history.jsonl"], undefined, repo).stdout).toContain("post-merge, post-checkout, post-rewrite, post-commit");
    expect(run(HISTORY, ["hook", hist], undefined, perf).stdout).toContain("already in every hook");
    const postCommit = readFileSync(join(hooks, "post-commit"), "utf8");
    expect(postCommit.startsWith("#!/bin/sh\necho earlier hook\n")).toBe(true);
    expect(postCommit.match(/keep the dashboard current/g)).toHaveLength(1);
    expect(readFileSync(join(hooks, "post-merge"), "utf8")).toMatch(/^#!\/bin\/sh\nbun ".*history\.ts" sync "perf\/perf-history\.jsonl"/);

    // A result that arrives by commit, as it would by merge or pull, reaches the data file
    writeFileSync(hist, '{"t":"2026-10-01T00:00:00Z","kind":"event","label":"from git"}\n');
    git("add", ".");
    const commit = git("commit", "-q", "-m", "result");
    expect(commit.stdout + commit.stderr).toContain("earlier hook"); // git sends hook output to stderr
    expect(readFileSync(join(perf, "perf-dashboard.data.js"), "utf8")).toContain('"label":"from git"');
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

  test("the data file carries the journeys, and a journeys change redraws", () => {
    const text = '{"t":"2026-10-01T00:00:00Z","kind":"field","key":"a","value":1}\n';
    const journeys = '[{"key":"zap","title":"Channel change","members":["zap.survey","zap.total"]}]';
    let got: { stamp: string; journeys: unknown[] } | undefined;
    new Function("window", dataScript(text, journeys))({ perfDashboard: (p: typeof got) => (got = p) });
    expect(got!.journeys).toEqual([{ key: "zap", title: "Channel change", members: ["zap.survey", "zap.total"] }]);
    const stamp = (j: string) => dataScript(text, j).match(/"stamp":"(\w+)"/)![1];
    expect(stamp(journeys)).not.toBe(stamp(""));
  });

  test("sync rewrites the data file, with perf-journeys.json, once a dashboard exists", () => {
    const d = mkdtempSync(join(dir, "sync-"));
    const hist = join(d, "perf-history.jsonl");
    writeFileSync(hist, '{"t":"2026-10-01T00:00:00Z","kind":"field","key":"a","value":1}\n');
    expect(run(HISTORY, ["sync", hist], undefined, d).stdout).toContain("nothing to do");
    expect(existsSync(join(d, "perf-dashboard.data.js"))).toBe(false);
    writeFileSync(join(d, "perf-dashboard.html"), "");
    writeFileSync(join(d, "perf-journeys.json"), '[{"key":"j","members":["a"]}]');
    expect(run(HISTORY, ["sync", hist], undefined, d).status).toBe(0);
    expect(readFileSync(join(d, "perf-dashboard.data.js"), "utf8")).toContain('"journeys":[{"key":"j","members":["a"]}]');
  });

  test("the page script compiles", () => {
    const html = renderHtml("x");
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    expect(scripts).toHaveLength(1);
    expect(() => new Function(scripts[0])).not.toThrow();
    expect(html).toContain('<script src="perf-dashboard.data.js"></script>');
  });
});
