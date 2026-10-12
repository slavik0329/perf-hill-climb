# Web frontend

Load, navigation, interaction latency, layout stability and frame budget. Most examples come from the claude.ai sprint (`case-studies.md`).

## Finding the cost

- **Lab:** the DevTools Performance panel, or a trace over CDP `Tracing`, shows main-thread work per interaction. The React Profiler shows commits and why each one rendered.
- **Field:** a `PerformanceObserver` on `long-animation-frame` (with script attribution) and `layout-shift`. RUM per journey at p75.
- **Lighthouse** is a smoke test. It isn't a metric to climb.
- **Web Vitals are a floor, not the target.** Individual layout shifts of 0.008 never tripped CLS's 0.1 threshold, yet 31% of page loads moved something after the page was usable.

## Lab counts that track the clock

| Count | How |
|---|---|
| JS instructions on a hot path | the benchmark under Valgrind with `node --predictable`, against a checked-in baseline; one run, no statistics |
| React commits per interaction | the Profiler API in a scripted interaction |
| V8 function call counts | precise coverage (`Profiler.startPreciseCoverage` with call counts) |
| Layout and style recalcs | CDP `Performance.getMetrics` (`LayoutCount`, `RecalcStyleCount`) around the interaction |
| DOM mutations | a `MutationObserver` counter |
| Shifts per named region | the Layout Instability API, mapped to regions (below) |

## Layout stability, by region

1. Map each `layout-shift` entry's `sources[].node` to a named region (sidebar, transcript, composer) and a phase (before first paint, before typeable, after typeable). Send that as a field event.
2. Write an integration test that loads the page in the bad case (for example, sidebar data held back until after first paint). Fail it on any shift in a named region. On claude.ai the test was red on main in 20 of 20 runs and green on the PR in 20 of 20.
3. Fix causes by name, in batches: a late header row, a caret sliding once a username loads, a list jumping when its scrollbar appears.

## Frame budget

- Headless Chromium ticks at 60 Hz. DevTools begin-frame control steps it deterministically at 120 Hz, an 8.33 ms budget per frame, so "did this frame fit" becomes an exact answer per frame.
- Step through a long realistic interaction (a streamed reply, a big list) and time each frame.
- What worked:
  - memoize finished blocks, so no O(length) work happens per chunk
  - tokenize growing content in a worker
  - reveal tables cell by cell

  Main-thread blocking on long replies fell from ~750 to ~200 ms, at 120 fps.

## Finds worth checking for

- **The same lookup repeated.** A quarter of one path's instructions were megamorphic dictionary lookups resolving the same ID three times.
- **Re-render storms.** A census found 6,900 hooks and 900 store subscriptions re-rendering on every keystroke.
- **One expensive selector.** A single `:root:has()` added 24 ms to every DOM change.
- **Hidden reloads.** A leftover `location.reload()` caused ~500,000 reloads a day that no load metric saw. Trace what happens after first paint.
- **Idle-tab work.** Identical cache snapshots were being cloned into IndexedDB twice a minute.
- **Two-byte strings.** One em dash or curly quote makes V8 store a string as UTF-16, and every regex over it takes the slow path. Highlighting one code block froze the page for ~1 s. Copying the block into a one-byte string first cut that to 0.35 s.
- **Startup.** Bake a static, usable shell into the HTML. Keep heavy components mounted between views. Prefetch on hover.

## Shipping

- **Classify every flag** as a kill switch or a ramp, and retire it as soon as it's safe. In two weeks claude.ai added ~200 flags and had removed more than half of them by the end.
- **Show the human before/after recordings for taste calls:** should a table fill cell by cell? Should a skeleton appear at once or after 0.5 s? Is a text fade worth a fifth of the frame budget?

## Protect brittle wins

A static shell breaks quietly when the real component changes. To catch that:
- Generate its markup by rendering the real component (in jsdom, say), with a test that fails on drift.
- Compare the static and live renders across 14 viewport sizes, to within 1 px.
- Type straight through the handoff in a test, and fail on any lost or reordered keystroke.
- In the field, report each handoff's shift to a tenth of a pixel.

## Lab gaps

Chrome's speculative prerender lays out the page at the current tab's height. Managed browsers show a 56 px footer on the new-tab page, so the page grew 56 px about 100 ms after first paint, and the composer dropped ~10 px. Headless Chrome has no browser UI, so no lab test could see this. An internal user reported it four hours after release. The fix pinned the layout across the resize, and a test now simulates the prerender.
