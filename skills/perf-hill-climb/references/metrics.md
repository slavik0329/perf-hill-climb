# Choosing and validating lab counts

A lab count earns its place by doing two jobs. You can move it in minutes without waiting for field data, and CI can hold it with a ceiling that only goes down (`ratchet.md`). It only does those jobs if it is deterministic: same code, same number, one run.

## The ladder

Use the most deterministic rung that still tracks what users feel.

| Rung | Examples | Determinism |
|---|---|---|
| Field wall-clock | RUM p75, wake telemetry, request logs | noisy, but ground truth |
| Lab wall-clock | `hyperfine`, a benchmark loop with percentiles | noisy |
| Simulated time | a fake clock advanced by `delay()`, timeouts and retries (`harness.md`); a headless browser's virtual time | exact |
| Instruction counts | Valgrind (`--tool=callgrind`, total `Ir`) with `node --predictable`; `perf stat -e instructions` | exact or near |
| Operation counts | commits, style recalcs, DOM mutations, V8 calls, queries, upstream calls, file opens, flash writes, radio begins, bus transactions | exact |
| Lint counts | occurrences of a known-slow call in the source | exact |

## Validate against the clock before trusting a count

Fix one hot path and measure both the count and the wall clock:

| Hot path | Fix | Instructions | Wall-clock |
|---|---|---|---|
| Message-tree assembly | resolve each ID once, not three times | −48% | −78% (4.6×) |
| Status-line scanner | cheap first-character check before the regex | −31% | −44% (1.8×) |

Take counts under Valgrind with `node --predictable`, and timings with the JIT warm. If the count moves but the clock doesn't (it counts work off the critical path), unship the benchmark. The claude.ai team's bar was: "prove that hill climbing against each of these can result in measurable wall clock perf wins. we'll unship the benches for any candidates that cannot prove that."

A count stands in for the user's experience; it isn't the experience. Pair every budget with the field metric it represents, and check that metric after shipping.

## Make the uncountable countable

When something only shows up as noisy time, find a way to step it deterministically:

| Problem | Make it exact by |
|---|---|
| Frames | stepping headless Chromium with DevTools begin-frame control (`web.md`) |
| Waits on hardware or the network | running the real logic against fakes on a simulated clock, replaying scripted events (`harness.md`) |
| Jank | mapping each layout shift to a named region, then counting shifts per region (`web.md`) |

## Sweep once a count exists

Measure the count across the whole app, not just the path that was reported. In the claude.ai sprint, sweeps found wins nobody had reported:
- a hook census
- style-recalc cost per selector
- work done after first paint
- idle-tab profiling
- CPU hitches

## When tuning many knobs on wall-clock time

Keep tuning runs and evaluation runs separate. Report the spread with the result. A 3% gain inside a 10% spread is noise.
