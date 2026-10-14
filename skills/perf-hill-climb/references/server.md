# Backend and server

APIs, services, databases, queues: anything a client waits on.

## Finding the cost

- A sampling profiler under production-like load, read as a flame graph: `perf record -g` (Linux), `node --cpu-prof`, `py-spy`, `async-profiler`, Go `pprof`.
- `EXPLAIN ANALYZE` for one slow query; the slow-query log for which queries; distributed traces for which hop.
- Server-side packet capture (`tcpdump -n -tt -i eth0 "host <client> and port <port>"`) when the question is whether the time was the server or the path.

## Guarding it

- **Count per request in tests:** queries (a driver hook or `counted()` from `assets/harness/fakes.ts`), upstream calls, bytes serialized. These are exact, so they ratchet. A query count turns an N+1 regression into a red test instead of a slow week.
- **A `Server-Timing` header** carrying the phase split (db, upstream, render) lets browser RUM and device telemetry attribute their wait without access to server logs.
- **Load tests at a fixed arrival rate,** not fixed virtual users waiting on each response. A closed-loop tester under-reports the tail, because slow responses also delay the requests that would have measured them (coordinated omission).

## Easy to miss

- **Server latency is part of the client's budget.** On a battery device, each ms of server and path time is a ms of radio-on time. A board's fetch phase included a 44–84 ms round trip that varied by hour. A LAN or edge server would have cut it.
- **For tiny payloads, the protocol is the cost.** A ~1 KB fetch moved from HTTP over TCP to one UDP datagram each way (with HTTP as the fallback). The device's radio mean went from 592 to 423 ms in an A/B. Pad the request to at least the reply size and rate-limit per address, so the endpoint can't be used for amplification.
- **Precompute what every client asks for.** Poll the upstream once per interval and serve every request from the cached payload, rather than fetching per request.
- **Compare deploys over the same hours and weekdays,** or use flag cohorts within one period. Traffic mix drifts.
- **Archive request logs before replacing the container that writes them.** A redeploy can silently delete the only record of the "before".
- **Count SQL statements, not ORM calls, and count them under latency.** Prisma merges `findUnique` calls issued in the same tick into one `IN (...)` query. In a blockchain indexer, 1,234 per-row lookups were 64 statements against a zero-latency fake RPC and 1,189 against the real one. Once fetching was batched, removing that N+1 cut ORM calls 1,297 → 67 and left wall-clock unchanged (n=3 each), because the ORM was already merging them.
- **The largest range a provider allows isn't the fastest.** Alchemy answered `eth_getLogs` over 9,500–10,001 old Base blocks in 0.55–2.2 s, but over 20,000 blocks in 0.15–0.31 s and 50,000 in 0.27–0.48 s (n=4 per size, randomized). Bigger ranges cut a 100k-block catch-up from 34.6–38.2 s to 15.8–16.5 s. Time a few sizes before taking the one the docs suggest, and halve a range the provider rejects.
