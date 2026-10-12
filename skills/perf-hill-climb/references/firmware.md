# Firmware and embedded

Microcontrollers, battery devices, wake/sleep cycles, radios, displays and sensors. The examples are from battery-powered Wi-Fi devices that wake on a timer, fetch data and update a display.

## Finding the cost

- **Per-phase timestamps in the wake record are the profiler** (boot, init, filesystem, connect, fetch, draw, display, teardown, plus radio-on ms). When a phase is too coarse to act on, split it. `millis()` misses ROM and bootloader time; calibrate that once against a current trace.
- **A current trace with markers.** Use a power profiler (Nordic PPK2, Joulescope) whose digital input sees a GPIO toggled at each phase boundary. It shows charge per phase, not just time.
- **A logic analyzer on the bus** shows transaction counts and gaps that reading the code misses.
- **The schematic,** for anything on the always-on rail. Telemetry can't see sleep current. Meter it once, with USB unplugged, because a USB connection keeps clocks and PLLs up.
- **Energy per cycle** is measured time × datasheet current per state. Label it an *estimate* until metered.

## Lab and bench

- **Host tests** run the real decision logic (connect policy, retry timing, state machines, retained-memory layouts) against SDK fakes on a simulated clock (`harness.md`).
- **What to count:**
  - blocked ms per scenario
  - file opens and flash writes
  - radio `begin()` calls and key-derivation runs
  - bus transactions per page

  Each fake copies the pinned SDK version's contract. In one Arduino core version, `WiFi.status()` stays stale until the next driver event, so a wait loop restarted 255+ times in 2.6 s.
- **Bench firmware, one per hardware question:** no Wi-Fi, no sleep cycle, back-to-back trials, results on serial. That took ~15 s per run, against 5–8 minutes per idea through the app's wake cycle. Flash it directly; on short wakes, catch the bootloader on a wake or flash over the built-in JTAG.
- **Force rare states** instead of waiting for them:

| State | Trick |
|---|---|
| Fast reconnect fails | corrupt one byte of the cached BSSID on alternate wakes |
| Cold boot | restart instead of deep-sleeping after each wake |
| Peripheral back in its power-up state | pulse its reset line at the end of alternate wakes |
| Timing of a wake whose serial output is lost | store timestamps in retained memory, print them on the next wake |

## Observer effects

- **Opening a serial monitor can reset the chip.** On native-USB chips, reopening the port each wake made every wake a cold boot (full scan, full redraw), so healthy firmware looked broken. Read sleep/wake behaviour from server telemetry.
- **Native USB serial may hold output until the host sends a byte.** Lines printed before the port opens are lost, and light sleep drops USB.
- **To check the board is alive without touching it,** poll for the USB port's presence without opening it, and photograph the screen's timestamp.

## Hidden costs found in real wakes

- **Always-on peripherals.** One LoRa radio left in standby drew ~0.6 mA around the clock, ~30× the board's deep sleep.
- **Switched rails back-fed through I/O.** A peripheral whose supply is off while its data lines stay high is powered through its input diodes. Drive those lines low, or hold them, before sleep.
- **Library timeouts.**
  - A stream read waits its full 1 s timeout at end of file.
  - The TCP stack's 3 s initial retransmit timeout makes a lost segment cost 3 s, then 6 s more. Retry the whole request with short timeouts instead.
  - Connect polling runs every 100 ms.
- **Work redone every wake.** WPA2 key derivation took ~1 s at 80 MHz on every connect; cache the derived key. Also cache DNS, the DHCP lease and parsed settings in retained memory.
- **Join choice.** Joining the first AP to answer rather than the strongest. As 802.11n, one mesh dropped downlink packets for seconds, and 802.11b/g didn't. Measure on the real network.
- **One bus transaction per byte.** A display driver sent 4,737 SPI transactions per page. Sending one per page halved the update.
- **Boot banners** at 115200 baud cost ~13 ms per wake.
- **Busy-waiting on a slow peripheral.** Light-sleep or drop the clock while an e-ink panel's BUSY line is high.

## Mechanisms that silently don't engage

- A light-sleep call that the SDK skips when a timer is due "runs" but never sleeps. Check the current or a wake-reason register.
- A power-save setting applied before the framework's start handler gets overwritten. Confirm the setting after start.
- A GPIO wake source can leave a power domain on through every later deep sleep. Reset the domain configuration after each light sleep.

## Retained memory

- Know which section survives what. On ESP32, `RTC_DATA_ATTR` is reinitialized on any non-deep-sleep boot (restart, OTA, watchdog); `RTC_NOINIT_ATTR` survives them. A/B and failure counters belong in the one that survives.
- Guard each record with a magic number, a format version and a CRC, and bump the format on any layout change.

## Shipping

- A release script that refuses a dirty tree or an existing tag, and tags the image's commit, size and hash. This makes one-change-per-version enforceable rather than a promise.
- Ship an opt-in build flag first. Make it the default only after its gates pass: no timeouts, and field numbers unchanged or better.
- Battery policies are part of the budget:
  - failure backoff: 300 → 600 → 1200 → 1800 s
  - skip a firmware version that failed OTA, for a growing number of wakes
  - longer sleeps at night

## Debugging traps

- **Check free stack before blaming power.** A stack overflow on a 4 KB-stack chip produced power-on and watchdog reset reasons that looked like brownouts.
- **Fast restarts can hide the driver's failure reasons,** which only arrive after its longer timeout.
- **"The AP ignores us"** was the device's own driver stalling: a sniffer showed the AP answering in 2 ms.
