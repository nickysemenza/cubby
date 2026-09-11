import { z } from "zod";
import productDefinition from "./entity-definitions/00-product.entity";
import { readFieldSchemas } from "./entity-definitions/definition";

export const productTopLevelOut = z
  .object(readFieldSchemas(productDefinition))
  .extend({
    // Derived at read time by the same cover rule the picker uses (first
    // displayable, non-deleted image, ordered by sortOrder/createdAt/id — see
    // `getProductCoverImageUrlsByProductIds`), not a stored column, so it is
    // appended here rather than declared on the entity definition's read list.
    coverImageUrl: z.url().nullable(),
  });
