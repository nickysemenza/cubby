/**
 * Maps the identity product joined onto a location — the SKU the location IS,
 * as opposed to stock held at it.
 *
 * Its own module rather than living in `location/helpers.ts` because
 * `inventory/mappers.ts` needs it too, and helpers already imports from there;
 * putting it in either would make the pair circular.
 */

import { unsafeProductShortcode } from "@cubby/schemas/identifiers";
import { isDisplayableImageFile } from "@cubby/schemas/image";
import type { LocationIdentityProductOut } from "@cubby/schemas/location";
import { isNotDeleted, mapImages } from "~/server/repo/database-helpers";
import type { LocationIdentityProductRow } from "./internal-types";

export const mapLocationIdentityProduct = (
  row: { product?: LocationIdentityProductRow | null } | null | undefined,
): LocationIdentityProductOut | null => {
  const product = row?.product;
  if (!product || !isNotDeleted(product)) return null;
  return {
    id: unsafeProductShortcode(product.shortcode),
    name: product.name,
    manufacturer: product.manufacturer,
    model: product.model ?? null,
    category: product.category ?? null,
    // First DISPLAYABLE image, not first image: `mapImages` drops soft-deleted
    // rows but deliberately keeps documents and failed renders, so `[0]` here
    // could hand a PDF manual to every surface that draws this as a thumbnail.
    coverImage: mapImages(product.images).find(isDisplayableImageFile) ?? null,
    price: product.price ?? null,
  };
};
