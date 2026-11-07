import { PRODUCT_DISCARD_READ_FIELDS } from "~/entity/actions/action-read-fields";
import { specialistListReadProjection } from "~/entity/entity-list/list-read-demand";

export const productListReadProjection = specialistListReadProjection({
  always: [
    ...PRODUCT_DISCARD_READ_FIELDS,
    "cost",
    "price",
    "primaryGtin",
    "inventoryEntry",
    "stockStatus",
    "ingredient",
    "componentCount",
  ],
});
