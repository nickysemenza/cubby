/**
 * The run's deterministic shuffle seed. Vitest orders files with it, and tests
 * that sample a large case space draw their sample from it, so one seed
 * reproduces both. `project.json` keys the Nx test cache on the variable.
 */
export function testShuffleSeed(): number {
  const seed = Number.parseInt(
    process.env.CUBBY_TEST_SHUFFLE_SEED ?? "20260831",
    10,
  );
  if (!Number.isSafeInteger(seed)) {
    throw new Error("CUBBY_TEST_SHUFFLE_SEED must be an integer");
  }
  return seed;
}

/** Mulberry32: a tiny seeded PRNG, enough to pick reproducible samples. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
