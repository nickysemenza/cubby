import {
  collectionMatrixMembership,
  collectionMatrixSort,
  collectionSlug,
} from "@cubby/schemas/collection";
import { z } from "zod";

import { urlStringParam } from "~/lib/search-params";

/**
 * Shared leaf module: the route validates search with this schema, and
 * `CollectionAssignmentMatrix` consumes the same inferred type, without
 * either one importing the other and creating a cycle.
 */
export const collectionAssignmentSearchSchema = z.object({
  subject: z.enum(["product", "location"]).optional().catch(undefined),
  q: urlStringParam,
  page: z.coerce.number().int().positive().optional().catch(undefined),
  rows: z.coerce
    .number()
    .int()
    .refine((value) => value === 100 || value === 250 || value === 500)
    .optional()
    .catch(undefined),
  sort: collectionMatrixSort.optional().catch(undefined),
  collection: collectionSlug.optional().catch(undefined),
  membership: collectionMatrixMembership.optional().catch(undefined),
});
export type CollectionAssignmentSearch = z.infer<
  typeof collectionAssignmentSearchSchema
>;
