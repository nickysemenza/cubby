import { z } from "zod";
import { dbTimestampsOut, ndb, upc } from "./util";

export const productBase = z.object({
  name: z.string(),
  upc: upc.nullable(),
  ndb_number: ndb.nullable(),
  manufacturer: z.string(),
  model: z.string().nullable(),
});

export const productTopLevelOut = z
  .object({
    id: z.string().uuid(),
  })
  .merge(productBase)
  .merge(dbTimestampsOut);
