# Field telemetry, A/B runs and reports

Lab counts show a change works; the field shows it mattered. If there's no field data, ship the instrumentation alone first, so a "before" exists.

## The per-run record

One small record per run of the journey (a wake, a page load, a request):

- ms per phase plus the total
- the costly resource as its own field (radio-on ms, main-thread blocked ms)
- outcome and path taken
- diagnostics that explain failures (attempts, reason codes, signal)
- version and A/B arm

Keep it compact and versioned: `v1;n=412;out=ok;boot=31;wifi=142;fetch=88;draw=612;tot=905;radio=221;ab=1`.

**Log raw values next to derived ones.** A raw ADC count logged beside the computed mV showed a dead divider. On the mV figure alone, it looked like a dead cell.

## Report the previous run on the next one

A run that crashes, browns out or loses its connection can't report itself:

1. Keep the record in storage that survives the failure. On a microcontroller, retained RAM guarded by a magic number, a format version and a CRC. Elsewhere, `localStorage`/IndexedDB or a local file.
2. Set an "in progress" flag at the start and clear it at the end. If the flag is still set at the next start, the run never finished; report it as `crash`.
3. Send the previous record with the next request, as a header or a field.
4. Keep running failure counters (count, and awake time since the last success). The report can then rebuild failure streaks that never reached the server and charge their cost.

**The first report after an update describes the old version.** Attribute it accordingly.

## The report script

Per version, the script prints:
- n and the date range
- p50/p95 per phase over successful runs
- the mean of the costly resource over all runs
- the failure rate, with streaks rebuilt from the counters and their cost per 100 runs
- an estimated cost per run, with its assumptions printed
- per-arm tables, with per-factor marginals

Give the script its own tests. One report merged separate failure streaks, which would have misled every comparison after it.

## Collector hygiene

These are cheap, and each one was learned by losing data:
- Deduplicate by device and sequence number, because a retried request logs twice.
- Archive logs before redeploying the collector.
- Keep the release version in a tracked file, not in local config. A gitignored config once reported a version three releases older than the one deployed.
- Telemetry is untrusted input. Allowlist its keys and bound its size.

## A/B within one period

Sequential before/after comparisons mislead whenever conditions drift: Wi-Fi by the hour, traffic by the day, a night window full of slow full refreshes.

- **Pick the arm per run** from a persistent counter (`counter % 2`), a hash of the device or user, or a flag cohort. Log the arm in every record.
- **Factorial arms** settle two questions in one run. Use one counter bit per factor and report each factor's marginal.
- **Size the run before starting.** At ~5% failures and ~360 wakes a day, showing a halving takes about three days per factor. Stop early only for a stated reason.
- **Split by the affected subset before calling a result flat.** If the change only touches runs that hit a retry, compare those runs.
- **Means for energy and money,** since outliers drain the battery and the bill. **Percentiles for latency.** Always report n.

## Look at both ends

When the record says *that* something failed but not *why*, before guessing:
- capture packets on the server
- put an independent sniffer on the radio channel
- point a camera at the device's screen
- or ship a diagnostics-only version that records reason codes

Know each instrument's blind spots. A device that turns its radio off right after reading never sends its final ACK, so the server's retransmits aren't losses. A sniffer with a weak antenna misses frames that were sent.
