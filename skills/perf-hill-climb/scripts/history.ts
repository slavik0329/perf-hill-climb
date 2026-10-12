#!/usr/bin/env bun
// Performance history: an append-only JSONL file of measurements over time, and the data file
// that keeps an open perf-dashboard.html (see dashboard.ts) up to date.
//
//   field    <history> <measured|-> --version V [--stat p50|mean|p95|...] [--n N] [--unit ms]
//                                   [--source measured|estimate|simulated|datasheet] [--better higher]
//                                   [--note TEXT] [--t ISO]
//   lab      <history> <budget> <measured|->   record ceilings and lab counts that changed since last time
//   event    <history> <label> [--type release|revert|note] [--version V] [--t ISO]
//   backfill <history> <budget>                record every past ceiling from the budget file's git history
//
// Every write also rewrites perf-dashboard.data.js when perf-dashboard.html sits next to the
// history file, so an open dashboard redraws within seconds. Runs on bun or Node 22.6+.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
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

export function dashboardPaths(historyPath: string) {
  const dir = dirname(resolve(historyPath));
  return { html: join(dir, "perf-dashboard.html"), data: join(dir, "perf-dashboard.data.js") };
}

/** The data file the dashboard polls: plain JS, so it loads from file:// where fetch() can't. */
export function dataScript(historyText: string): string {
  const entries = parseHistory(historyText);
  const stamp = createHash("sha1").update(historyText).digest("hex").slice(0, 12);
  const payload = JSON.stringify({ stamp, generated: new Date().toISOString(), entries });
  return `window.perfDashboard && window.perfDashboard(${payload.replace(/</g, "\\u003c")});\n`;
}

/** Rewrites the data file if this history has a dashboard. Returns whether it did. */
export function syncDashboard(historyPath: string, force = false): boolean {
  const { html, data } = dashboardPaths(historyPath);
  if (!force && !existsSync(html)) return false;
  writeFileSync(data, dataScript(existsSync(historyPath) ? readFileSync(historyPath, "utf8") : ""));
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

function flags(args: string[]): { positional: string[]; opts: Record<string, string> } {
  const positional: string[] = [];
  const opts: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) opts[args[i].slice(2)] = args[++i] ?? "";
    else positional.push(args[i]);
  }
  return { positional, opts };
}

function readInput(path: string): string {
  return readFileSync(path === "-" ? 0 : path, "utf8");
}

const USAGE = `usage:
  history.ts field    <history> <measured|-> --version V [--stat S] [--n N] [--unit U] [--source S] [--better higher] [--note T] [--t ISO]
  history.ts lab      <history> <budget> <measured|->
  history.ts event    <history> <label> [--type release|revert|note] [--version V] [--t ISO]
  history.ts backfill <history> <budget>`;

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
