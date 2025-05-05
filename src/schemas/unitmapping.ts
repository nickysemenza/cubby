import { z } from "zod";
import { dbTimestampsOut } from "./util";
import { amount } from "~/codec/codec";

export const unitMappingBase = z.object({
  a: amount.describe("first of pair"),
  b: amount.describe("second of pair"),
  source: z.string().nullable(),
});

export const unitMappingOut = z
  .object({
    id: z.string().uuid(),
  })
  .merge(unitMappingBase)
  .merge(dbTimestampsOut);

export type UnitMapping = z.infer<typeof unitMappingBase>;
export type UnitMappingOut = z.infer<typeof unitMappingOut>;
