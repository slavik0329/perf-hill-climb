#!/usr/bin/env bun
// Writes perf-dashboard.html next to a perf-history.jsonl and fills perf-dashboard.data.js.
// Open the HTML file in a browser; it re-reads the data file every 2 s, and every history.ts
// write refreshes that file, so the page stays current with no server running.
//
//   dashboard.ts <history> [--title TEXT]
//
// Runs on bun or Node 22.6+. dashboard.template.html must sit next to this script.
import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dashboardPaths, syncDashboard } from "./history.ts";

const TEMPLATE = join(dirname(fileURLToPath(import.meta.url)), "dashboard.template.html");

export function renderHtml(title: string): string {
  const text = title.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);
  const json = JSON.stringify(title).replace(/</g, "\\u003c");
  return readFileSync(TEMPLATE, "utf8").replace("__TITLE_TEXT__", () => text).replace("__TITLE_JSON__", () => json);
}

export function writeDashboard(historyPath: string, title: string): { html: string; data: string } {
  const paths = dashboardPaths(historyPath);
  writeFileSync(paths.html, renderHtml(title));
  syncDashboard(historyPath, true);
  return paths;
}

export function main(argv: string[]): number {
  const positional = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--title");
  const titleAt = argv.indexOf("--title");
  const historyPath = positional[0];
  if (!historyPath) {
    console.error("usage: dashboard.ts <history> [--title TEXT]");
    return 2;
  }
  const title = titleAt >= 0 && argv[titleAt + 1] ? argv[titleAt + 1] : `${basename(dirname(resolve(historyPath)))} performance`;
  const { html, data } = writeDashboard(historyPath, title);
  console.log(`DASHBOARD ${html}\nDASHBOARD data ${data} (rewritten by every history.ts write; the page re-reads it every 2 s)`);
  return 0;
}

const isMain =
  (import.meta as { main?: boolean }).main ??
  (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url));
if (isMain) process.exit(main(process.argv.slice(2)));
