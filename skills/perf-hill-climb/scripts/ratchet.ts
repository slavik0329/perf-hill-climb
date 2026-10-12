#!/usr/bin/env bun
// Budget ratchet: deterministic per-scenario counts with ceilings that may only go down.
//
//   check <budget> <measured|->   fail if a measurement is OVER its ceiling or MISSING from the budget
//   lower <budget> <measured|->   lower ceilings to the measured values (never raises), keeping comments
//   guard <budget> [base-ref]     fail if a ceiling rose or a key disappeared relative to base (origin/main)
//
// Budget file: one `key ceiling  # note` per line; `#` starts a comment.
// Measurements: a JSON object (nested keys joined with "."), `key value` lines, or the
// `BUDGET key value / ceiling` lines this script and similar harnesses print. If any line starts
// with BUDGET, only those lines are read, so a whole test log can be piped in. A key measured
// twice keeps its worst (highest) value.
//
// Runs on bun, or on Node 22.6+ with type stripping. No dependencies.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type Values = Map<string, number>;
export type Status = "ok" | "lower" | "over" | "missing" | "unmeasured";
export type Row = { key: string; measured?: number; ceiling?: number; status: Status };

const NUMBER = /^-?\d+(\.\d+)?$/;
const KEY = /^[\w.\-/]+$/;

export function parseBudget(text: string): Values {
  const out: Values = new Map();
  text.split("\n").forEach((raw, i) => {
    const fields = raw.replace(/#.*/, "").trim().split(/\s+/);
    if (fields.length < 2 || fields[0] === "") return;
    if (!NUMBER.test(fields[1])) throw new Error(`line ${i + 1}: ceiling for ${fields[0]} is not a number: ${fields[1]}`);
    if (out.has(fields[0])) throw new Error(`line ${i + 1}: duplicate key ${fields[0]}`);
    out.set(fields[0], Number(fields[1]));
  });
  return out;
}

export function parseMeasured(text: string): Values {
  const out: Values = new Map();
  const put = (key: string, value: number) => out.set(key, Math.max(value, out.get(key) ?? -Infinity));
  if (text.trimStart().startsWith("{")) {
    const walk = (node: unknown, prefix: string) => {
      if (typeof node === "number" && Number.isFinite(node)) put(prefix, node);
      else if (node && typeof node === "object" && !Array.isArray(node))
        for (const [k, v] of Object.entries(node)) walk(v, prefix ? `${prefix}.${k}` : k);
    };
    walk(JSON.parse(text), "");
    return out;
  }
  const lines = text.split("\n").map((raw) => raw.replace(/#.*/, "").trim().split(/\s+/));
  const tagged = lines.some((fields) => fields[0] === "BUDGET");
  for (const fields of lines) {
    if (tagged) {
      if (fields[0] !== "BUDGET") continue;
      fields.shift();
    }
    if (fields.length >= 2 && KEY.test(fields[0]) && NUMBER.test(fields[1])) put(fields[0], Number(fields[1]));
  }
  return out;
}

export function check(budget: Values, measured: Values): Row[] {
  const rows: Row[] = [];
  for (const [key, value] of measured) {
    const ceiling = budget.get(key);
    const status: Status =
      ceiling === undefined ? "missing" : value > ceiling ? "over" : value < ceiling ? "lower" : "ok";
    rows.push({ key, measured: value, ceiling, status });
  }
  for (const [key, ceiling] of budget) if (!measured.has(key)) rows.push({ key, ceiling, status: "unmeasured" });
  return rows;
}

export function formatRow(row: Row): string {
  const key = row.key.padEnd(34);
  if (row.status === "unmeasured") return `BUDGET ${key} ${"-".padStart(6)} / ${row.ceiling}  (not measured)`;
  const value = String(row.measured).padStart(6);
  if (row.status === "missing") return `BUDGET ${key} ${value}  MISSING from budget file`;
  const note = row.status === "over" ? "  OVER" : row.status === "lower" ? "  (lower the ceiling)" : "";
  return `BUDGET ${key} ${value} / ${row.ceiling}${note}`;
}

export type Change = { key: string; from: number; to: number };

// Rewrites only the ceiling token of each lowered line, keeping its comment and right alignment.
export function lower(budgetText: string, measured: Values): { text: string; changes: Change[] } {
  const changes: Change[] = [];
  const lines = budgetText.split("\n").map((line) => {
    const m = line.match(/^(\s*)(\S+)(\s+)(-?\d+(?:\.\d+)?)(?=\s|#|$)(.*)$/);
    if (!m || m[2].startsWith("#")) return line;
    const [, indent, key, gap, ceiling, rest] = m;
    const value = measured.get(key);
    if (value === undefined || value >= Number(ceiling)) return line;
    changes.push({ key, from: Number(ceiling), to: value });
    const next = String(value);
    return indent + key + " ".repeat(Math.max(1, gap.length + ceiling.length - next.length)) + next + rest;
  });
  return { text: lines.join("\n"), changes };
}

export function guard(base: Values, current: Values): string[] {
  const problems: string[] = [];
  for (const [key, was] of base) {
    const now = current.get(key);
    if (now === undefined) problems.push(`RATCHET ${key}: removed (was ${was})`);
    else if (now > was) problems.push(`RATCHET ${key}: raised ${was} -> ${now}`);
  }
  return problems;
}

function git(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return undefined;
  }
}

function readInput(path: string): string {
  return readFileSync(path === "-" ? 0 : path, "utf8");
}

const USAGE = `usage:
  ratchet.ts check <budget> <measured|->
  ratchet.ts lower <budget> <measured|->
  ratchet.ts guard <budget> [base-ref]   (default origin/main)`;

export function main(argv: string[]): number {
  const [command, budgetPath, arg] = argv;
  if (!budgetPath || (command !== "guard" && !arg)) {
    console.error(USAGE);
    return 2;
  }
  const budgetText = readFileSync(budgetPath, "utf8");

  if (command === "check") {
    const rows = check(parseBudget(budgetText), parseMeasured(readInput(arg)));
    for (const row of rows) console.log(formatRow(row));
    const bad = rows.filter((r) => r.status === "over" || r.status === "missing").length;
    const loose = rows.filter((r) => r.status === "lower").length;
    if (bad) console.log(`FAIL: ${bad} budget(s) exceeded or missing`);
    else console.log(`ok${loose ? `: ${loose} ceiling(s) can be lowered (ratchet.ts lower)` : ""}`);
    return bad ? 1 : 0;
  }

  if (command === "lower") {
    parseBudget(budgetText); // refuse to rewrite a malformed file
    const { text, changes } = lower(budgetText, parseMeasured(readInput(arg)));
    for (const c of changes) console.log(`LOWER ${c.key}: ${c.from} -> ${c.to}`);
    if (changes.length) writeFileSync(budgetPath, text);
    else console.log("LOWER nothing to lower");
    return 0;
  }

  if (command === "guard") {
    const base = arg ?? "origin/main";
    const dir = dirname(resolve(budgetPath));
    const spec = `${base}:./${basename(budgetPath)}`;
    if (git(dir, ["rev-parse", "--verify", "-q", `${base}^{commit}`]) === undefined) {
      console.log(`RATCHET skipped: ${base} not found`);
      return 0;
    }
    const baseText = git(dir, ["show", spec]);
    if (baseText === undefined) {
      console.log(`RATCHET skipped: ${basename(budgetPath)} does not exist on ${base} yet`);
      return 0;
    }
    const problems = guard(parseBudget(baseText), parseBudget(budgetText));
    for (const p of problems) console.log(p);
    if (!problems.length) console.log("RATCHET ok: no ceiling rose relative to base");
    return problems.length ? 1 : 0;
  }

  console.error(USAGE);
  return 2;
}

const isMain =
  (import.meta as { main?: boolean }).main ??
  (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url));
if (isMain) process.exit(main(process.argv.slice(2)));
