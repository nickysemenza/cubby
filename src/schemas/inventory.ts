import { z } from "zod";
import { amount } from "~/codec/codec";
import { dbTimestampsOut } from "./util";

export const inventoryEntryOut = z
  .object({
    id: z.string().uuid(),
    amount: amount,
  })
  .merge(dbTimestampsOut);

export const inventoryUpdatePayloadData = z.object({
  amount: amount.optional(),
  productId: z.string().uuid().optional(),
  locationId: z.string().uuid().optional(),
});

export const inventoryCreatePayloadData = z.object({
  productId: z.string().uuid(),
  locationId: z.string().uuid(),
  amount: amount,
});
