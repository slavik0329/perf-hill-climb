# Worked example: the claude.ai sprint

Use it to calibrate scope, cadence and how results are reported. It is not a template to copy blindly.

## claude.ai web and desktop (Aug 2026, two weeks)

Source: [How we made claude.ai faster](https://claude.dev/blog/how-we-made-claude-ai-faster/).

**Setup.** Claude was a member of one Slack channel with standing instructions to own performance: watch deploys for regressions, audit telemetry, keep dashboards, fix low-hanging fruit, propose projects. It read usage data through a Datadog MCP server and picked 4 journeys (launch, start a conversation, load a conversation, send a message) covering 95% of user activity, which became 13 measurements across web and desktop. Instrumentation was added until each measurement started at a user interaction, ended at render, and split client from server. Claude estimated ~20 projects in milliseconds; the estimates became sprint targets, and 12 of 13 were hit by day three.

**Method.**
- Lab metrics that move without waiting for deploys: JS instruction counts, React commits, V8 call counts, layout and style recalcs, DOM mutations. Each benchmark had to prove it moved wall-clock time or be unshipped.
- A ratchet: any PR that raised instruction counts on guarded paths failed CI, and a daily job lowered ceilings.
- The loop per thread: report a slow spot → trace and benchmark → PRs sized for risk, behind flags → watch the field → ratchet or roll back → next slow spot. More than 150 threads ran at once, sometimes 50–100 PRs per thread, up to 200+ changes landing on the busiest days. About a third of PRs added telemetry or guardrails.

**Results (RUM p75, Aug 13 → Aug 27).**

| Journey | Before | After | Speedup |
|---|---|---|---|
| Web fresh load to typeable | 3,085 ms | 550 ms | 5.6× |
| Desktop cold start | 6,310 ms | 3,328 ms | 1.9× |
| Load conversation, Cowork cloud | 2,566 ms | 728 ms | 3.5× |
| Send message (client), Cowork cloud | 928 ms | 48 ms | 19× |
| Geometric mean of 13 measurements | | | 3.1× |

More than 3,000 changes merged with no customer-facing incidents or rollbacks: automated review plus a human approval on every PR, tests before optimizations, short-lived flags, staged rollouts.

**Steering.** Humans set ambition ("please be braver"; "the targets are not the stopping point"), made taste calls from before/after recordings, kept threads narrow with a named owner, and cut off low-value work ("2 ms per send is not worth the complexity of maintaining this build plugin").

