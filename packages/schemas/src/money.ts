import { z } from "zod";

const CENT_EPSILON = 1e-7;

/** True when a finite dollar amount resolves to an exact whole cent. */
const isWholeCentAmount = (value: number): boolean =>
  Number.isFinite(value) &&
  Math.abs(value * 100 - Math.round(value * 100)) <= CENT_EPSILON;

/** Authoritative dollar values may not carry fractions of a cent. */
export const wholeCentAmount = z
  .number()
  .finite()
  .refine(isWholeCentAmount, "amount must resolve to a whole cent");
