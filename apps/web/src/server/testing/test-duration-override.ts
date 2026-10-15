import { z } from "zod";

const durationMs = z.coerce.number().int().positive();

/**
 * A workerd harness shortens a production interval through a Worker var.
 * Unset keeps the production default; anything but a positive integer
 * throws, because 0 or NaN silently disables pg-pool's idle release and
 * makes a settlement job fire every millisecond.
 */
export function testDurationOverrideMs(
  value: string | undefined,
): number | undefined {
  return value ? durationMs.parse(value) : undefined;
}
