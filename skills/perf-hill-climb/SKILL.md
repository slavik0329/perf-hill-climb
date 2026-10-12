---
name: perf-hill-climb
description: >-
  Hill-climb performance on numbers: break the journey users feel into phases,
  profile to find the cost, guard it with deterministic lab counts validated
  against the clock, confirm in the field, and lock wins with budgets that only
  ratchet down. Use when asked to speed something up or cut latency, startup
  time, jank, frame drops, battery drain, wake time, radio-on time, CPU or
  queries; to set up benchmarks, perf budgets, telemetry or regression guards; to
  find out why something is slow; to continue an earlier performance effort; to
  track or chart performance gains over time; or to run a perf sprint or "hill
  climb". Firmware, web, server, desktop and CLI.
---

# Performance hill climb

Method from [How we made claude.ai faster](https://claude.dev/blog/how-we-made-claude-ai-faster/): once something is measured, Claude can make it faster, so the leverage is in finding more things to measure. This file holds only what isn't obvious; the reference files hold platform specifics.

## 1. Resume before you start

A climb outlives a context window. Before measuring anything, look for what an earlier session left:

```bash
git ls-files | grep -iE 'perf|budget|efficien|benchmark|wake.?report|telemetry'; git tag --sort=-creatordate | head
```

- **Perf doc:** read Status, Open leads and Didn't help first. Continue from the next step it names. Don't retry anything under Didn't help without a new reason.
- **Budget file:** its ceilings are the baseline. Run the checks before changing code.
- **Field report script:** run it over the window since the last release before deciding anything. A running A/B may already have its answer.
- **`perf-history.jsonl`:** the trend so far, one measurement per line. Regenerate the dashboard from it (below) and give the user the path.

No perf doc and the task is a climb: start one from `assets/perf-log-template.md`, and start the history and dashboard (`references/history.md`):

```bash
bun scripts/history.ts backfill perf/perf-history.jsonl perf/perf-budget.txt   # past ceilings from git, if a budget exists
bun scripts/dashboard.ts perf/perf-history.jsonl --title "<project>"           # then: open perf/perf-dashboard.html
```

The page re-reads its data every 2 s, and every `history.ts` write refreshes that data, so it stays current with no server running.

## 2. Size the process to the task

- **Quick** (one slow command, a one-off script, "why is this slow?"): profile, fix the top cost, measure before and after the same way, report the numbers. No doc, no budgets.
- **Climb** (a journey users feel, a long-lived codebase, battery life): the loop below.
- **Escalate from quick to climb** when the fix must stay fixed (it needs a budget), the cost shows only in the field, or a second slow spot sits behind the first.

## 3. The loop

1. **Define the journey** from a user-visible start to a usable result, in phases (client and server, or one per wake phase). No field data yet: ship the instrumentation alone first, so a "before" exists.
2. **Profile to find, count to guard.** A profiler or per-phase telemetry finds where the time goes. A deterministic count (instructions, simulated-clock ms, queries, renders, writes) that you have shown moves with the wall clock guards it (`references/metrics.md`).
3. **Read the source** of the library, SDK or framework at the hot spot, and its issue tracker, before forming a theory. Cite it. Most mysterious costs are a documented default or timeout.
4. **Reproduce in the smallest harness,** ideally matching the field numbers exactly. If one experiment takes minutes, fix the loop first.
5. **Fix, then prove the guard can fail:** put the old behaviour back and watch the budget go red.
6. **Ship so the effect can be attributed:** one change per release when the evidence is field data, and arms within one period when conditions drift. Then read the field. If it held, ratchet the budget down. If not, revert and add it to Didn't help with its numbers.
   - **Record each step in the history,** so the dashboard shows the climb as it happens:
     - `history.ts event … --type release` (or `revert`) for each release
     - `history.ts field` for each field result, with `--version`, `--stat`, `--n`, and `--source estimate` when it isn't measured
     - `history.ts lab` after the lab checks
7. **Move to the next slow spot in the same journey.** The target isn't the stopping point. Stop on purpose, when the remaining cost is something code can't move.

## 4. Your defaults that hurt here

- **Caution.** You ticket findings, hedge, pad estimates and stop at the target. The article's team had to ask for "please be braver". Fix it, then find the next one.
- **Theorizing from code.** A claim about library or hardware behaviour that you haven't checked against the source or a measurement is a guess. Label it, or go check.
- **Trusting one timing.** A single wall-clock run proves nothing. A count or a distribution does.
- **Bundling changes.** Two changes in one field release can't be told apart.
- **Blurring provenance.** Every number in a report says whether it is measured, simulated, from a datasheet or an estimate.
- **Calling an A/B flat on the whole population.** First split by the subset the change touches. One test looked flat at p = 0.71, yet every affected run was exactly 200 ms faster.

## 5. Traps that look like success

- **Aggregates hide costs.** Layout shifts of 0.008 each never tripped CLS's 0.1 threshold, yet 31% of page loads moved after becoming usable. A wake's total time hid a 1 s timeout at the end of a file read.
- **The instrument changes the result.** A serial monitor reset the chip on every wake, so healthy firmware looked broken. Devtools, debug builds, cold JITs and profilers do the same in other forms.
- **Code that ran isn't a mechanism that engaged.** A light-sleep call the SDK silently skipped and a power-save setting the framework overrode both "ran". Check the effect: current, a register, a trace.
- **A guard or harness that can't fail.** `compile && run` under `set -e` silently skipped tests that stopped compiling.
- **Failures don't report themselves.** Send each run's record with the next run (`references/telemetry.md`), or crashes vanish from the data.
- **The dominant cost is outside the instrument.** An idle radio on an always-on rail outweighed all the wake work, and only the schematic showed it. When a floor dominates, a meter beats more code.
- **The lab isn't the field.** Headless Chrome has no browser UI to retract, so a prerender footer shifted the page only in real browsers. A bench network isn't the user's network. Keep staged rollouts and field telemetry.
- **Wins decay.** A brittle win, like a static shell standing in for a component, needs a parity test, or the next refactor undoes it.

## 6. Before the session ends

- **Update the project's perf doc:**
  - Status: what's in the field, what's running, the next step.
  - Results, each with n, dates and version.
  - Didn't help.
  - Open leads.

  The next session starts from it.
- **Make sure the history holds every result** the doc quotes, and commit it.
- **Save lessons you didn't already know.** If a lesson would save time on another project on the same platform, add one bullet with its evidence to the matching `references/<platform>.md` here, if this skill directory is a writable checkout, and tell the user. Leave out anything that would surprise nobody.

## References

Read only what the task needs.

- `references/firmware.md`: microcontrollers, battery, wake/sleep, radios, displays.
- `references/web.md`: load, navigation, interaction latency, layout shift, frame budget.
- `references/server.md`: APIs, databases, load tests.
- `references/desktop-cli.md`: cold/warm start, Electron, CLIs.
- `references/metrics.md`: choosing and validating a lab count, making the uncountable countable.
- `references/telemetry.md`: field profiles, A/B arms, report scripts.
- `references/ratchet.md`: budget files, the CI guard, lowering ceilings.
- `references/history.md`: the history file, its commands, and the live dashboard.
- `references/harness.md`: fake clocks, counting fakes and in-test budget checks. Copyable TypeScript and C++ is in `assets/harness/`.
- `references/case-studies.md`: the claude.ai sprint, for calibrating scope and reporting.

## Scripts

The scripts in `scripts/` run on bun or Node 22.6+ with no dependencies. Copy them into the project, for example into `perf/`, leaving out the tests. Each one prints its usage when run without arguments.

```bash
bun ratchet.ts check perf-budget.txt measured.json   # exit 1 if any key is OVER or MISSING
bun ratchet.ts lower perf-budget.txt measured.json   # rewrite ceilings down to measured; never raises
bun ratchet.ts guard perf-budget.txt origin/main     # exit 1 if a ceiling rose or a key vanished
bun history.ts field|lab|event|backfill perf-history.jsonl …   # append to the history (references/history.md)
bun dashboard.ts perf-history.jsonl --title "<project>"        # write perf-dashboard.html next to it
```

Measured input can be JSON, `key value` lines, or a test log with `BUDGET key value / ceiling` lines.
