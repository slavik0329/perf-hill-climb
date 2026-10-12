# Lab harness: fake clocks, counting fakes, budget checks

The lab layer runs the real logic against fakes that count work and simulate time, then checks each count against a ceiling. Copy the files in `assets/harness/` into the project's test folder.

| File | Language | What it gives you |
|---|---|---|
| `budget.ts` | TypeScript (bun test, Node) | `budget(key, measured)`: prints a `BUDGET` line, returns false when over or missing |
| `fakes.ts` | TypeScript | `Clock`/`FakeClock` (sleep advances time, counts `blockedMs`), `counted(obj)` (counts method calls by name) |
| `budget.h` | C/C++ | `Budget::check(key, measured)`, `Budget::result()` as `main()`'s exit code |
| `fake_clock.h` | C/C++ | `millis()`, `delay()`, `fake::wait/advance/blockedMs` for embedded code |

Both budget checks read `PERF_BUDGET_FILE` (default `perf-budget.txt`). Their output pipes straight into `scripts/ratchet.ts check`.

## Rules that make it work

- **Inject time and I/O.** Code under test takes a clock, a client or a stream as a parameter, or calls functions that the test build links to fakes. Code that reads `Date.now()` or calls `setTimeout` itself can't be measured deterministically.
- **Fakes copy the real waiting contract from the library's source.** The measurement is only as true as the fake. Example: an SDK's `readString()` calls a timed read per character, and at end of data that read spins until its 1 s timeout. The fake must add the whole timeout to `blockedMs`, or the 1 s-per-wake stall never shows up. Pin the library version the fake copies.
- **Script scenarios from field data:** a slow reply, a lost first attempt, a peer that never answers, a stale status. Name each budget key after its scenario (`wifi.fast_lost_auth.blocked_ms`).
- **One process per test file, with sanitizers in C/C++** (`-Werror -fsanitize=address,undefined`). Compile and run on separate lines, never `compile && run` under `set -e`.
- **After each fix, put the old behaviour back** and confirm the matching budget goes `OVER`.

## Shapes

TypeScript, counting queries per request and time blocked in retries:

```ts
import { expect, test } from "bun:test";
import { budget } from "./budget.ts";
import { FakeClock, counted } from "./fakes.ts";

test("conversation fetch", async () => {
  const clock = new FakeClock();
  const db = counted(realDbClientOrInMemoryFake);
  await getConversation("c1", { db: db.proxy, clock });
  expect(budget("api.conversation_get.queries", db.counts.get("query") ?? 0)).toBe(true);
  expect(budget("api.conversation_get.blocked_ms", clock.blockedMs)).toBe(true);
});
```

C++, a wake path on the host:

```cpp
#include "fake_clock.h"   // test build: replaces the SDK's millis()/delay()
#include "budget.h"
int main() {
    fake::reset();
    FakeWiFi wifi; wifi.loseFirstAuth = true;   // scripted scenario
    connectFast(wifi);
    Budget::check("wifi.fast_lost_auth.blocked_ms", fake::blockedMs);
    Budget::check("wifi.fast_lost_auth.begin_calls", wifi.beginCalls);
    return Budget::result();
}
```

Lint budgets need no harness: `grep -c` a known-slow call in the source and `Budget::check` or `budget()` the count against a ceiling of 0.
