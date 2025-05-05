import { z } from "zod";
import { dbTimestampsOut } from "~/schemas/util";

export const ingredientBase = z.object({
  name: z.string(),
  aliases: z.array(z.string()),
});
export const ingredientOut = z
  .object({
    id: z.string().uuid(),
  })
  .merge(ingredientBase)
  .merge(dbTimestampsOut);
