/**
 * Maps the identity product joined onto a location — the SKU the location IS,
 * as opposed to stock held at it.
 *
 * Its own module rather than living in `location/helpers.ts` because
 * `inventory/mappers.ts` needs it too, and helpers already imports from there;
 * putting it in either would make the pair circular.
 */

import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import type { LocationIdentityProductOut } from "@cubby/schemas/location";

import { isNotDeleted } from "~/server/db/helpers/query";

import type { LocationIdentityProductRow } from "./internal-types";

export const mapLocationIdentityProduct = (
  row: { product?: LocationIdentityProductRow | null } | null | undefined,
): LocationIdentityProductOut | null => {
  const product = row?.product;
  if (!product || !isNotDeleted(product)) return null;
  return {
    id: parseShortcodeFor("product", product.shortcode),
    name: product.name,
    brandName: product.brandName,
    model: product.model ?? null,
    category: product.category ?? null,
    price: product.price ?? null,
  };
};
