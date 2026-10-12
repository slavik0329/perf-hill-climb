# perf-hill-climb

A Claude Code skill for making software measurably faster or leaner by hill-climbing on numbers.

It packages the method from Anthropic's [How we made claude.ai faster](https://claude.dev/blog/how-we-made-claude-ai-faster/) and extends it to firmware, servers and desktop/CLI apps:

- pick the journeys users feel and break them into phases
- turn each phase into a deterministic lab count, validated against the clock
- read the source before theorizing
- change one thing at a time
- compare arms within one period
- confirm in the field
- lock each win with a budget that only ratchets down

## What's inside

```
skills/perf-hill-climb/
├── SKILL.md                  resume, sizing, the loop, your defaults, traps
├── references/
│   ├── metrics.md            choosing and validating lab metrics; making the uncountable countable
│   ├── telemetry.md          per-phase field profiles, report-previous-run, A/B arms, report scripts
│   ├── ratchet.md            budget files, CI guard, daily lowering
│   ├── history.md            the history file, its commands, the live dashboard
│   ├── harness.md            fake clocks, counting fakes, in-test budget checks
│   ├── firmware.md           microcontrollers, battery, wake/sleep, radios, displays
│   ├── web.md                load, navigation, interaction latency, layout shift, frame budget
│   ├── server.md             APIs, databases, load tests, tail latency
│   ├── desktop-cli.md        cold/warm start, Electron, CLIs
│   └── case-studies.md       the claude.ai sprint, condensed
├── assets/
│   ├── perf-log-template.md  living perf doc: status, results, ranked fixes, didn't-help, pitfalls, leads
│   ├── budget-template.txt   example budget file
│   └── harness/              in-test budget checks, fake clock, counting fakes (TypeScript and C++)
└── scripts/
    ├── ratchet.ts            budget check / lower / guard
    ├── history.ts            append field results, lab counts, ceilings and releases to perf-history.jsonl
    ├── dashboard.ts          write a live perf-dashboard.html next to the history (with dashboard.template.html)
    └── *.test.ts             bun test (harness.test.ts also compiles the C++ headers)
```

Claude loads `SKILL.md` when a request matches. It first looks for an earlier session's perf doc and budgets, sizes the process to the task, and reads a reference file only when its platform or topic is in play.

## Install

As a plugin, from GitHub:

```
/plugin marketplace add slavik0329/perf-hill-climb
/plugin install perf-hill-climb@perf-hill-climb
```

From a local clone:

```
/plugin marketplace add /path/to/perf-hill-climb
/plugin install perf-hill-climb@perf-hill-climb
```

Or as a personal skill without the plugin system:

```bash
ln -s "$PWD/skills/perf-hill-climb" ~/.claude/skills/perf-hill-climb
```

## Use

Ask in plain words, for example "startup feels slow, can we make it faster?", "set up perf budgets for the API", or "why is battery life a month instead of a year?". You can also invoke it with `/perf-hill-climb`.

The scripts run on bun or Node 22.6+ with no dependencies, and work on their own:

```bash
bun skills/perf-hill-climb/scripts/ratchet.ts check perf-budget.txt measured.json
bun skills/perf-hill-climb/scripts/ratchet.ts lower perf-budget.txt measured.json
bun skills/perf-hill-climb/scripts/ratchet.ts guard perf-budget.txt origin/main
bun skills/perf-hill-climb/scripts/history.ts lab perf-history.jsonl perf-budget.txt test.log
bun skills/perf-hill-climb/scripts/dashboard.ts perf-history.jsonl --title "my-app"
open perf-dashboard.html   # redraws within 2 s of every history.ts write; no server needed
```

Tests: `cd skills/perf-hill-climb/scripts && bun test`.

## Credits

The method, the claude.ai examples and all quotes come from [How we made claude.ai faster](https://claude.dev/blog/how-we-made-claude-ai-faster/).

MIT licensed.
