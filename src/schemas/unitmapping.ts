import { z } from "zod";
import { amount } from "~/codec/codec";
import { dbTimestampsOut } from "./util";

export const unitMappingBase = z.object({
  a: amount.describe("first of pair"),
  b: amount.describe("second of pair"),
  source: z.string().nullable(),
});
export type UnitMapping = z.infer<typeof unitMappingBase>;

export const unitMappingOut = z
  .object({
    id: z.string().uuid(),
  })
  .merge(unitMappingBase)
  .merge(dbTimestampsOut);

export type UnitMappingOut = z.infer<typeof unitMappingOut>;
