// Split out of `number-format` so modules that must stay WASM-free (the calendar
// Durable Object's nutrition text) can round without loading the formatters.

/** Round to `digits` decimals as a number (`roundTo(1.2345, 2) === 1.23`). */
export function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}
