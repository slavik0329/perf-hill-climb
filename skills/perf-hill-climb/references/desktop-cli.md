# Desktop, CLI and native

Electron and native apps, command-line tools, and anything whose first cost is process startup. In the claude.ai sprint, desktop cold start went from 6.3 s to 3.3 s at p75.

## Finding the cost

- **Node, and Electron's main process:** `node --cpu-prof` writes a `.cpuprofile` to open in DevTools.
- **Electron renderers:** Chromium tracing (`--trace-startup`).
- **Native code:** Instruments' Time Profiler on macOS, `perf record -g` on Linux.
- **Wall clock:** `hyperfine --warmup 3 '<cmd>'` for warm starts; `hyperfine --prepare '<clear the app cache>' '<cmd>'` for cold ones.

Cold and warm starts are different journeys. Measure and report them separately.

## Guarding it

Startup counts that ratchet:
- modules loaded (`NODE_DEBUG=module`, a loader hook, or the bundler's metafile)
- bytes of JS in the startup chunk
- files opened and syscalls before first input:
  - Linux: `strace -c -f`
  - macOS: `fs_usage` or `dtruss`. Both need root, and `dtruss` also needs SIP relaxed.

## Easy to miss

- **Recompiling JS on every launch.** Ship a precompiled V8 code cache, so the main process doesn't compile at startup.
- **Waiting for the framework before anything is usable.** Show a static shell the user can already type into, and hand off to the live UI. Guard the handoff with a parity test and a keystroke test (`web.md`, "Protect brittle wins").
- **Test on the slowest supported machine.** A cold start on an older laptop is its own journey, and it's where the regressions show first.
