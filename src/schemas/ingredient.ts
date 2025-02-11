import { z } from "zod";
import { dbTimestampsOut } from "~/schemas/util";

export const ingredientBase = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    aliases: z.array(z.string()),
  })
  .merge(dbTimestampsOut);
