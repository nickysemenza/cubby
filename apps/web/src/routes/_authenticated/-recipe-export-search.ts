import { z } from "zod";

export const recipeExportSearchSchema = z.object({
  format: z
    .enum(["prep", "read", "nested", "matrix", "flow"])
    .optional()
    .catch(undefined),
  scale: z.number().positive().optional().catch(undefined),
});
