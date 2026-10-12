// Fakes for counting work deterministically in tests.
// Code under test takes a Clock instead of reading time or calling setTimeout itself; tests pass
// a FakeClock, which advances instantly and counts what the code would have waited.

export interface Clock {
  now(): number; // ms
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = {
  now: () => performance.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export class FakeClock implements Clock {
  t = 0;
  blockedMs = 0; // time the code under test spent waiting
  sleeps = 0;
  now(): number {
    return this.t;
  }
  async sleep(ms: number): Promise<void> {
    this.t += ms;
    this.blockedMs += ms;
    this.sleeps++;
  }
  /** Time passing outside the code under test: a slow reply, a peer's timeout. */
  advance(ms: number): void {
    this.t += ms;
  }
}

/**
 * Wraps an object (a DB client, an HTTP client, a storage layer) so every method call is
 * counted by name. Pass `proxy` to the code under test; read `counts` in the test.
 */
export function counted<T extends object>(target: T): { proxy: T; counts: Map<string, number> } {
  const counts = new Map<string, number>();
  const proxy = new Proxy(target, {
    get(obj, prop, receiver) {
      const value = Reflect.get(obj, prop, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        counts.set(String(prop), (counts.get(String(prop)) ?? 0) + 1);
        return value.apply(obj, args);
      };
    },
  });
  return { proxy, counts };
}
