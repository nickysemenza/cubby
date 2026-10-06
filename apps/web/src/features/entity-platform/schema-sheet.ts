import { z } from "zod";

/** Schema tab sub-sheets. Kept apart from the grid so the `/entities` route's
 * search validation never pulls the inspector metadata into its eager chunk. */
export const schemaSheetSchema = z.enum([
  "entities",
  "overrides",
  "relations",
  "photos",
  "graph",
]);
export type SchemaSheet = z.infer<typeof schemaSheetSchema>;
