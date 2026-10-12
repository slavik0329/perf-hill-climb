// In-test budget check. Compares a deterministic measurement with its ceiling in the budget
// file (PERF_BUDGET_FILE, default perf-budget.txt) and prints the line `ratchet.ts check` reads:
//   BUDGET <key> <measured> / <ceiling>[  OVER | (lower the ceiling)]
// Usage (bun test): expect(budget("api.conversation_get.queries", db.counts.get("query"))).toBe(true)
import { readFileSync } from "node:fs";

let ceilings: Map<string, number> | undefined;
let failures = 0;

function load(file: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const [key, ceiling] = line.replace(/#.*/, "").trim().split(/\s+/);
    if (key && ceiling !== undefined) out.set(key, Number(ceiling));
  }
  return out;
}

/** False (after printing OVER or MISSING) when the measurement breaks its budget. */
export function budget(key: string, measured: number): boolean {
  const file = process.env.PERF_BUDGET_FILE ?? "perf-budget.txt";
  ceilings ??= load(file);
  const ceiling = ceilings.get(key);
  const head = `BUDGET ${key.padEnd(34)} ${String(measured).padStart(6)}`;
  if (ceiling === undefined) {
    console.log(`${head}  MISSING from ${file}`);
    failures++;
    return false;
  }
  const note = measured > ceiling ? "  OVER" : measured < ceiling ? "  (lower the ceiling)" : "";
  console.log(`${head} / ${ceiling}${note}`);
  if (measured > ceiling) failures++;
  return measured <= ceiling;
}

export const budgetFailures = (): number => failures;
