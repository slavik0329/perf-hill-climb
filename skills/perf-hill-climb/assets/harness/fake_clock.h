#pragma once
// Simulated time for C/C++ host tests of embedded code. delay() and every fake that waits
// advance fake::now and count fake::blockedMs, so tests measure waiting exactly, in one run.
// Fakes of the SDK's I/O must copy its real waiting contract from its source: for example, a
// stream read at end of data that spins until its timeout must add the whole timeout here.
#include <cstdint>

namespace fake {
inline unsigned long now = 0;       // simulated millis()
inline unsigned long blockedMs = 0; // time the code under test spent waiting
inline void reset() { now = 0; blockedMs = 0; }
inline void wait(unsigned long ms) { now += ms; blockedMs += ms; }  // a fake that blocks
inline void advance(unsigned long ms) { now += ms; }                // time passing elsewhere
}

inline unsigned long millis() { return fake::now; }
inline void delay(unsigned long ms) { fake::wait(ms); }
