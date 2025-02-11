import { z } from "zod";
import { amount } from "~/codec/codec";
import { dbTimestampsOut } from "./util";

export const inventoryEntryOut = z
  .object({
    id: z.string().uuid(),
    amount: amount,
  })
  .merge(dbTimestampsOut);
