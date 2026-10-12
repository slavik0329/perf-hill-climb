# Budgets that only go down

Every win becomes a guard. Each lab count gets a ceiling in a budget file. Tests fail when a measurement exceeds its ceiling, and CI fails when a change raises one.

## The budget file

```
# key                                  ceiling   # what it was before, and why it matters
data.load.blocked_ms                         0   # 1000: Stream::readString waited out its timeout at EOF
display.page_transfer.spi_transactions       2   # 4737: one transaction per byte (~185 ms a page)
wifi.fallback.blocked_ms                  2400   # 1500 fast timeout + 100 scan + 800 connect
lint.file_readString                         0   # Stream::readString on a File stalls 1 s
```

- **Keys** are `area.scenario.metric`: what the test simulated, and what it counted.
- **Ceilings** are integers, either counts or simulated ms.
- **Comments** record the value before the fix and the reason. A year later this is the only record of why the ceiling is 0.

There is a template in `assets/budget-template.txt`. The in-test checks are in `assets/harness/` (`harness.md`).

## Statuses

| Status | Meaning |
|---|---|
| `OVER` | fails |
| `MISSING` | fails, because a measurement without a ceiling isn't guarded |
| `(lower the ceiling)` | passes, but the win isn't locked in. Lower it in the same commit (`ratchet.ts lower`) |

## CI guard and lowering

- `ratchet.ts guard <budget> origin/main` fails if a ceiling rose or a key disappeared (deleting a guard is raising it to infinity). New keys pass. A missing base skips with a message. Raising a ceiling then takes a deliberate human override.
- A daily job runs the benchmarks on main, runs `lower` on the file, and commits if it changed. claude.ai did this, so incidental improvements became the new floor too.

## Lint budgets

When a stall comes from one known call, `grep -c` it in the source and give the count a ceiling of 0, or of the number of audited exceptions. Examples: a stream read that waits out its timeout at end of file, connect polling at 100 ms, `exists()` before `open()`.

## What not to ratchet

- **Wall-clock time.** It flakes, or it gets so much slack that it guards nothing. Ratchet a count shown to track the clock, and watch wall-clock time in the field.
- **Field percentiles.** Alert on them; don't gate merges on them.
