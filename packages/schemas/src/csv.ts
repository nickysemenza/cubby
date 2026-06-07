/**
 * Shared schema types for displaying field-level diffs.
 */

import { z } from "zod";

/**
 * Represents a single field change for displaying diffs.
 * Used by the product, recipe, and location forms.
 */
export const fieldChange = z.object({
  field: z.string(),
  from: z.unknown(),
  to: z.unknown(),
});

export type FieldChange = z.infer<typeof fieldChange>;
