import { z } from "zod";

const CENT_EPSILON = 1e-7;

const isWholeCentAmount = (value: number): boolean =>
  Number.isFinite(value) &&
  Math.abs(value * 100 - Math.round(value * 100)) <= CENT_EPSILON;

export const wholeCentAmount = z
  .number()
  .finite()
  .refine(isWholeCentAmount, "amount must resolve to a whole cent");
