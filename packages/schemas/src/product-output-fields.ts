import { z } from "zod";
import { generatedProductFieldSchemas } from "./generated/entity-field-schemas.product.gen";

// The generated map, not `readFieldSchemas(definition)`: the compiler
// synthesizes `dataQuality` from `capabilities.dataQuality`, and only the
// generated map carries its read schema.
export const productTopLevelOut = z
  .object(generatedProductFieldSchemas.read)
  .extend({
    // Derived at read time by the same cover rule the picker uses (first
    // displayable, non-deleted image, ordered by sortOrder/createdAt/id — see
    // `getProductCoverImageUrlsByProductIds`), not a stored column, so it is
    // appended here rather than declared on the entity definition's read list.
    coverImageUrl: z.url().nullable(),
  });
