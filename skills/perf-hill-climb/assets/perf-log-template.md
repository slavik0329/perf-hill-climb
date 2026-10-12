# <Project> performance

What this covers: the journeys, the platform, and where the numbers come from. Everything here was measured on <hardware / environment> between <date> and <date> unless marked *estimate*, *datasheet* or *simulated*.

## Status

Rewrite this at the end of every session. The next session starts here.

- **In the field:** <version>, released <date>. Read its effect after <date or n runs> with `<report command>`.
- **Running:** <A/B and its arms, or none>. It can be read after <n runs / date>.
- **Next step:** <one concrete action>.
- **Blocked on:** <a meter, a human taste call, a deploy, or nothing>.

## Results

| Journey or metric | Before | After |
|---|---|---|
| <journey, field, n, version> | <value> | <value> |
| <journey, lab> | <value> | <value> |

## Journeys and how they're measured

| Journey | Starts at | Ends at | Phases | Field source | Lab metric |
|---|---|---|---|---|---|
| <name> | <user interaction / wake> | <rendered / asleep> | <phase list> | <telemetry, RUM, logs> | <budget keys> |

## Candidates

Ranked by expected benefit × probability ÷ effort, before work starts. Don't add up estimates for fixes that overlap.

| Candidate | Expected benefit | Evidence / assumptions | Probability | Effort | Score | What would change the ranking |
|---|---|---|---|---|---|---|

## What each fix saved, largest first

| Rank | Fix | Version | Measured effect (before → after, n, dates) | Lab budget |
|---:|---|---|---|---|

## What didn't help

Measured, then reverted. Don't retry these without a new reason.

- **<change>:** <numbers, n, dates>. <why, if known>.

## Pitfalls

Things that misled the measurement or the fix, with the evidence that settled them.

- **<pitfall>:** <what happened and how it was found>.

## Open leads

| Candidate | Expected benefit | Status / what's needed |
|---|---|---|

## History

Dated entries, newest first: what shipped in each version and what the field showed afterwards.
