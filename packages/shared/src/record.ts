/**
 * Typed record builders for rosters keyed by a closed union.
 *
 * A `Record<K, V>` written out by hand is one line per key that has to be
 * re-typed whenever the union grows. Building it from the key list keeps the
 * literal key set — a missing key is a type error at the call site, not a
 * runtime `undefined` — and leaves exactly one place that enumerates it.
 */

/** Build `{ [K]: fn(K) }` over a closed key list, preserving the literal keys. */
export const mapRecord = <K extends string, V>(
  keys: readonly K[],
  fn: (key: K) => V,
): { [P in K]: V } =>
  // SAFETY: `fromEntries` widens to `{ [k: string]: V }`; every key in `keys`
  // (and no other) is present by construction.
  Object.fromEntries(keys.map((key) => [key, fn(key)])) as { [P in K]: V };

/** The typed key list of a record, for iterating a roster without a cast. */
export const recordKeys = <K extends string, V>(record: {
  readonly [P in K]: V;
}): readonly K[] =>
  // SAFETY: `Object.keys` erases to `string[]`; a record typed by a closed
  // union has exactly those keys.
  Object.keys(record) as K[];
