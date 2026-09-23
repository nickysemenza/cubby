import { entityFieldModels } from "@cubby/schemas/entity-fields";

import {
  getCategoryIcon,
  getFeatureColor,
} from "~/app/_components/products/category-theme";

/**
 * The manifest's feature roster (labels and descriptions) with each
 * feature's icon and chart color, so the pill matches every other place a
 * category is drawn.
 */
export const productCategoryFeatureOptions = (
  entityFieldModels.productCategory.fields.find(
    (field) => field.key === "feature",
  )?.control?.options ?? []
).map((option) => {
  const Icon = getCategoryIcon(option.value);
  return { ...option, icon: <Icon />, color: getFeatureColor(option.value) };
});
