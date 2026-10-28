import { PRODUCT_DISCARD_READ_FIELDS } from "~/entity/actions/action-read-fields";
import {
  declaredListReadProjection,
  type ListReadProjection,
} from "~/entity/entity-list/list-read-demand";

/** Used by the row action, kit hydration and specialist columns outside the field model. */
export const PRODUCT_COST_READ_FIELDS = ["cost", "price"] as const;
export const PRODUCT_GTIN_READ_FIELDS = ["primaryGtin"] as const;
export const PRODUCT_STOCK_READ_FIELDS = [
  "inventoryEntry",
  "stockStatus",
] as const;

export const productListReadProjection: ListReadProjection = (
  queryClient,
  entity,
  visibility,
) => {
  const fields = declaredListReadProjection(queryClient, entity, visibility);
  if (!fields) return undefined;
  return [
    ...new Set([
      ...fields,
      ...PRODUCT_DISCARD_READ_FIELDS,
      ...PRODUCT_COST_READ_FIELDS,
      ...PRODUCT_GTIN_READ_FIELDS,
      ...PRODUCT_STOCK_READ_FIELDS,
      "ingredient",
      "componentCount",
    ]),
  ].sort();
};
