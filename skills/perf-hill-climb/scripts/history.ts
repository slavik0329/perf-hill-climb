#!/usr/bin/env bun
// Performance history: an append-only JSONL file of measurements over time, and the data file
// that keeps an open perf-dashboard.html (see dashboard.ts) up to date.
//
//   field    <history> <measured|-> --version V [--stat p50|mean|p95|...] [--n N] [--unit ms]
//                                   [--source measured|estimate|simulated|datasheet] [--better higher]
//                                   [--note TEXT] [--t ISO] [--once]
//   lab      <history> <budget> <measured|->   record ceilings and lab counts that changed since last time
//   event    <history> <label> [--type release|revert|note] [--version V] [--t ISO]
//   backfill <history> <budget>                record every past ceiling from the budget file's git history
//   sync     <history>                         rewrite the dashboard's data file now
//   hook     <history>                         add `sync` to the repo's git hooks
//
// Every write also rewrites perf-dashboard.data.js when perf-dashboard.html sits next to the
// history file, so an open dashboard redraws within seconds. Results that arrive through git (a
// pull, a merge, another worktree's commits) don't pass through here: `hook` covers those.
// perf-journeys.json next to the history, when present, joins keys that measured one journey
// (references/history.md). Runs on bun or Node 22.6+.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseBudget, parseMeasured, type Values } from "./ratchet.ts";

export type Kind = "field" | "lab" | "ceiling" | "event";
export type Entry = {
  t: string; // ISO 8601
  kind: Kind;
  key?: string;
  value?: number;
  stat?: string; // field: p50, mean, p95, ...
  unit?: string;
  n?: number;
  version?: string;
  source?: "measured" | "simulated" | "estimate" | "datasheet";
  better?: "lower" | "higher";
  label?: string; // event
  type?: "release" | "revert" | "note"; // event
  note?: string;
};

const KINDS = new Set(["field", "lab", "ceiling", "event"]);

export function parseHistory(text: string): Entry[] {
  const out: Entry[] = [];
  text.split("\n").forEach((line, i) => {
    if (!line.trim()) return;
    let entry: Entry;
    try {
      entry = JSON.parse(line);
    } catch {
      throw new Error(`line ${i + 1}: not JSON`);
    }
    if (!entry || !KINDS.has(entry.kind) || Number.isNaN(Date.parse(entry.t)))
      throw new Error(`line ${i + 1}: needs "t" (ISO date) and "kind" (field, lab, ceiling or event)`);
    if (entry.kind === "event" ? !entry.label : !entry.key || !Number.isFinite(entry.value))
      throw new Error(`line ${i + 1}: ${entry.kind === "event" ? 'an event needs "label"' : 'needs "key" and a numeric "value"'}`);
    out.push(entry);
  });
  return out;
}

export function readHistory(path: string): Entry[] {
  return existsSync(path) ? parseHistory(readFileSync(path, "utf8")) : [];
}

/**
 * A journey whose results were recorded under several keys (a key per arm, survey or condition).
 * The dashboard draws its members as one line. Members are listed by precedence: when two have a
 * result for the same version and statistic, the line keeps the earlier one's. A journey's own key
 * counts as its last member.
 */
export type Journey = { key: string; title?: string; members: string[] };

export function journeysPath(historyPath: string): string {
  return join(dirname(resolve(historyPath)), "perf-journeys.json");
}

export function parseJourneys(text: string): Journey[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("perf-journeys.json: not JSON");
  }
  if (!Array.isArray(raw)) throw new Error("perf-journeys.json: needs an array of journeys");
  const owner = new Map<string, string>();
  return raw.map((j, i) => {
    const members = j?.members;
    if (typeof j?.key !== "string" || !Array.isArray(members) || !members.length || !members.every((m: unknown) => typeof m === "string"))
      throw new Error(`perf-journeys.json: journey ${i + 1} needs "key" and a non-empty "members" list of keys`);
    for (const m of new Set([...members, j.key])) {
      if (owner.has(m)) throw new Error(`perf-journeys.json: ${m} is in both ${owner.get(m)} and ${j.key}`);
      owner.set(m, j.key);
    }
    return { key: j.key, ...(typeof j.title === "string" && { title: j.title }), members };
  });
}

export function readJourneys(historyPath: string): Journey[] {
  const p = journeysPath(historyPath);
  return existsSync(p) ? parseJourneys(readFileSync(p, "utf8")) : [];
}

export function dashboardPaths(historyPath: string) {
  const dir = dirname(resolve(historyPath));
  return { html: join(dir, "perf-dashboard.html"), data: join(dir, "perf-dashboard.data.js") };
}

/** The data file the dashboard polls: plain JS, so it loads from file:// where fetch() can't. */
export function dataScript(historyText: string, journeysText = ""): string {
  const entries = parseHistory(historyText);
  const journeys = journeysText ? parseJourneys(journeysText) : [];
  const stamp = createHash("sha1").update(historyText).update("\0").update(journeysText).digest("hex").slice(0, 12);
  const payload = JSON.stringify({ stamp, generated: new Date().toISOString(), entries, journeys });
  return `window.perfDashboard && window.perfDashboard(${payload.replace(/</g, "\\u003c")});\n`;
}

/** Rewrites the data file if this history has a dashboard. Returns whether it did. */
export function syncDashboard(historyPath: string, force = false): boolean {
  const { html, data } = dashboardPaths(historyPath);
  if (!force && !existsSync(html)) return false;
  const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "");
  writeFileSync(data, dataScript(read(historyPath), read(journeysPath(historyPath))));
  return true;
}

export function appendHistory(historyPath: string, entries: Entry[]): void {
  if (entries.length) appendFileSync(historyPath, entries.map((e) => JSON.stringify(e) + "\n").join(""));
  syncDashboard(historyPath);
}

// The last recorded value, ignoring before-the-fix values taken from budget comments.
function last(history: Entry[], kind: Kind, key: string): number | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    const e = history[i];
    if (e.kind === kind && e.key === key && e.stat !== "before") return e.value;
  }
  return undefined;
}

/** Ceilings and lab counts that differ from the last recorded value for their key. */
export function labEntries(history: Entry[], budget: Values, measured: Values, t: string, version?: string): Entry[] {
  const out: Entry[] = [];
  for (const [key, value] of budget)
    if (last(history, "ceiling", key) !== value) out.push({ t, kind: "ceiling", key, value, ...(version && { version }) });
  for (const [key, value] of measured)
    if (last(history, "lab", key) !== value) out.push({ t, kind: "lab", key, value, ...(version && { version }) });
  return out;
}

/**
 * The field entries not recorded yet, so a report script can run as often as it likes: an entry
 * is skipped when its journey (any of its keys) already has its statistic and version. One that
 * repeats an earlier entry's key, statistic, version and `t` with at least half as many runs again
 * is a re-report: it's added, and the dashboard draws only the later of the two.
 */
export function unrecorded(history: Entry[], journeys: Journey[], entries: Entry[]): Entry[] {
  const journeyOf = new Map<string, string>();
  for (const j of journeys) for (const m of [...j.members, j.key]) journeyOf.set(m, j.key);
  const group = (key = "") => journeyOf.get(key) ?? key;
  const known = history.filter((h) => h.kind === "field");
  const out: Entry[] = [];
  for (const e of entries) {
    const same = known.filter((h) => h.version === e.version && (h.stat ?? "") === (e.stat ?? "") && group(h.key) === group(e.key));
    const rereport =
      same.length > 0 &&
      same.every((h) => h.key === e.key && h.t === e.t && h.n !== undefined) &&
      (e.n ?? 0) >= 1.5 * Math.max(...same.map((h) => h.n!));
    if (same.length && !rereport) continue;
    out.push(e);
    known.push(e);
  }
  return out;
}

const HOOKS = ["post-merge", "post-checkout", "post-rewrite", "post-commit"];
const HOOK_MARK = "# perf-hill-climb: keep the dashboard current";

/**
 * Adds a `sync` line to the repo's post-merge, post-checkout, post-rewrite and post-commit hooks,
 * so results that arrive through git reach an open dashboard too. Keeps what the hooks already do
 * and adds the line once. Returns the hooks it changed.
 */
export function installHooks(historyPath: string, scriptPath: string, runner: string): string[] {
  const dir = dirname(resolve(historyPath));
  const top = git(dir, ["rev-parse", "--show-toplevel"])?.trim();
  const hooks = git(dir, ["rev-parse", "--git-path", "hooks"])?.trim();
  if (!top || !hooks) throw new Error(`${dir} is not in a git repository`);
  const hooksDir = resolve(dir, hooks);
  mkdirSync(hooksDir, { recursive: true });
  // Hooks run from the top of the working tree, so the paths are relative to it
  const rel = (p: string) => relative(realpathSync(top), join(realpathSync(dirname(resolve(p))), basename(p)));
  const line = `${runner} "${rel(scriptPath)}" sync "${rel(historyPath)}" >/dev/null 2>&1 || true  ${HOOK_MARK}`;
  const changed: string[] = [];
  for (const name of HOOKS) {
    const p = join(hooksDir, name);
    const text = existsSync(p) ? readFileSync(p, "utf8") : "#!/bin/sh\n";
    if (text.includes(HOOK_MARK)) continue;
    writeFileSync(p, text.replace(/\n*$/, "\n") + line + "\n");
    chmodSync(p, 0o755);
    changed.push(name);
  }
  return changed;
}

function git(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return undefined;
  }
}

/** Values budget comments record from before the fix, in the documented `key ceiling  # <before>: <why>` form. */
export function beforeValues(budgetText: string): Values {
  const out: Values = new Map();
  for (const line of budgetText.split("\n")) {
    const m = line.match(/^\s*([^\s#]+)\s+-?\d+(?:\.\d+)?\s*#\s*(-?\d+(?:\.\d+)?):/);
    if (m) out.set(m[1], Number(m[2]));
  }
  return out;
}

/**
 * Every ceiling change in the budget file's git history, oldest first, skipping ones already
 * recorded. When a key first appears with a `# <before>: <why>` comment, the before value is
 * recorded too, as a lab count at the same commit.
 */
export function backfillEntries(history: Entry[], budgetPath: string): Entry[] {
  const dir = dirname(resolve(budgetPath));
  const file = basename(budgetPath);
  const log = git(dir, ["log", "--reverse", "--format=%H %cI", "--", file]) ?? "";
  const seen = new Set(history.filter((e) => e.kind !== "event").map((e) => `${e.kind}|${e.key}|${e.t}|${e.value}`));
  const current = new Map<string, number>();
  const out: Entry[] = [];
  const add = (e: Entry) => {
    if (!seen.has(`${e.kind}|${e.key}|${e.t}|${e.value}`)) out.push(e);
  };
  for (const line of log.trim().split("\n").filter(Boolean)) {
    const [sha, t] = line.split(" ");
    const text = git(dir, ["show", `${sha}:./${file}`]);
    if (text === undefined) continue;
    let budget: Values;
    try {
      budget = parseBudget(text);
    } catch {
      continue; // a malformed historical version: skip it
    }
    const before = beforeValues(text);
    const version = sha.slice(0, 7);
    for (const [key, value] of budget) {
      if (current.get(key) === value) continue;
      const before_ = before.get(key);
      if (!current.has(key) && before_ !== undefined && before_ !== value)
        add({ t, kind: "lab", key, value: before_, stat: "before", version, note: "before the fix (from the budget file's comment)" });
      current.set(key, value);
      add({ t, kind: "ceiling", key, value, version });
    }
  }
  return out;
}

// Flags that take no value
const SWITCHES = new Set(["once"]);

function flags(args: string[]): { positional: string[]; opts: Record<string, string> } {
  const positional: string[] = [];
  const opts: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith("--")) positional.push(args[i]);
    else if (SWITCHES.has(args[i].slice(2))) opts[args[i].slice(2)] = "true";
    else opts[args[i].slice(2)] = args[++i] ?? "";
  }
  return { positional, opts };
}

function readInput(path: string): string {
  return readFileSync(path === "-" ? 0 : path, "utf8");
}

const USAGE = `usage:
  history.ts field    <history> <measured|-> --version V [--stat S] [--n N] [--unit U] [--source S] [--better higher] [--note T] [--t ISO] [--once]
  history.ts lab      <history> <budget> <measured|->
  history.ts event    <history> <label> [--type release|revert|note] [--version V] [--t ISO]
  history.ts backfill <history> <budget>
  history.ts sync     <history>
  history.ts hook     <history>`;

export function main(argv: string[]): number {
  const [command, ...rest] = argv;
  const { positional, opts } = flags(rest);
  const historyPath = positional[0];
  if (!historyPath) {
    console.error(USAGE);
    return 2;
  }
  if (opts.t !== undefined && Number.isNaN(Date.parse(opts.t))) {
    console.error(`--t must be an ISO date, got: ${opts.t}`);
    return 2;
  }
  if (command === "sync") {
    const wrote = syncDashboard(historyPath);
    console.log(wrote ? `HISTORY sync: ${dashboardPaths(historyPath).data} rewritten` : `HISTORY sync: no perf-dashboard.html next to ${historyPath}, nothing to do`);
    return 0;
  }
  if (command === "hook") {
    // The runtime running this writes the hook line: bun, or node with type stripping
    const runner = (process.versions as { bun?: string }).bun ? "bun" : "node --experimental-strip-types";
    const changed = installHooks(historyPath, fileURLToPath(import.meta.url), runner);
    console.log(`HISTORY hook: ${changed.length ? `sync added to ${changed.join(", ")}` : "already in every hook"}`);
    return 0;
  }
  if (opts.once !== undefined && (command !== "field" || !opts.version)) {
    console.error("--once is for field results and needs --version");
    return 2;
  }
  const history = readHistory(historyPath);
  const t = opts.t ? new Date(opts.t).toISOString() : new Date().toISOString();
  let entries: Entry[];

  if (command === "field" && positional[1]) {
    const measured = parseMeasured(readInput(positional[1]));
    const source = opts.source as Entry["source"];
    const better = opts.better === "higher" ? "higher" : undefined;
    entries = [...measured].map(([key, value]) => ({
      t,
      kind: "field" as const,
      key,
      value,
      ...(opts.stat && { stat: opts.stat }),
      ...(opts.unit && { unit: opts.unit }),
      ...(opts.n && { n: Number(opts.n) }),
      ...(opts.version && { version: opts.version }),
      ...(source && { source }),
      ...(better && { better }),
      ...(opts.note && { note: opts.note }),
    }));
    if (opts.once) entries = unrecorded(history, readJourneys(historyPath), entries);
  } else if (command === "lab" && positional[1] && positional[2]) {
    const budget = parseBudget(readFileSync(positional[1], "utf8"));
    entries = labEntries(history, budget, parseMeasured(readInput(positional[2])), t, opts.version);
  } else if (command === "event" && positional[1]) {
    const type = (["release", "revert", "note"].includes(opts.type) ? opts.type : "note") as Entry["type"];
    entries = [{ t, kind: "event", label: positional[1], type, ...(opts.version && { version: opts.version }) }];
  } else if (command === "backfill" && positional[1]) {
    entries = backfillEntries(history, positional[1]);
  } else {
    console.error(USAGE);
    return 2;
  }

  appendHistory(historyPath, entries);
  console.log(`HISTORY ${command}: ${entries.length} entr${entries.length === 1 ? "y" : "ies"} added to ${historyPath}`);
  return 0;
}

const isMain =
  (import.meta as { main?: boolean }).main ??
  (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url));
if (isMain) process.exit(main(process.argv.slice(2)));
