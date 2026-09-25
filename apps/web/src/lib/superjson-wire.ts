import type { SuperJSONResult } from "superjson";
import { z } from "zod";

const superJsonStructureSchema = z.object({
  json: z.json(),
  meta: z.object({}).loose().optional(),
});

export const superJsonResultSchema = z.custom<SuperJSONResult>(
  (value): value is SuperJSONResult =>
    superJsonStructureSchema.safeParse(value).success,
);
