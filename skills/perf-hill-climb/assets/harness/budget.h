#pragma once
// In-test budget check for C/C++ host tests. Compares a deterministic measurement with its
// ceiling in the budget file (PERF_BUDGET_FILE, default perf-budget.txt) and prints the line
// `ratchet.ts check` reads. Call Budget::result() as main()'s return value.
//   Budget::check("wifi.fallback.blocked_ms", fake::blockedMs);
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <map>
#include <sstream>
#include <string>

namespace Budget {
inline const char* file() {
    const char* path = std::getenv("PERF_BUDGET_FILE");
    return path ? path : "perf-budget.txt";
}
inline std::map<std::string, long> load() {
    std::ifstream in(file());
    std::map<std::string, long> ceilings;
    for (std::string line; std::getline(in, line);) {
        std::istringstream fields(line.substr(0, line.find('#')));
        std::string key;
        long ceiling;
        if (fields >> key >> ceiling) ceilings[key] = ceiling;
    }
    return ceilings;
}
inline int exceeded = 0;
inline bool check(const char* key, long measured) {
    static const auto ceilings = load();
    const auto it = ceilings.find(key);
    if (it == ceilings.end()) {
        std::printf("BUDGET %-34s %6ld  MISSING from %s\n", key, measured, file());
        std::fflush(stdout);
        ++exceeded;
        return false;
    }
    const char* note = measured > it->second ? "  OVER" : measured < it->second ? "  (lower the ceiling)" : "";
    std::printf("BUDGET %-34s %6ld / %ld%s\n", key, measured, it->second, note);
    std::fflush(stdout); // keep the line if a later assert aborts
    if (measured > it->second) ++exceeded;
    return measured <= it->second;
}
inline int result() {
    if (exceeded) std::printf("FAIL: %d budget(s) exceeded or missing\n", exceeded);
    return exceeded ? 1 : 0;
}
} // namespace Budget
