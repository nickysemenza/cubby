import { entityFieldModel } from "~/entity/entity-model";
import {
  getCategoryIcon,
  getFeatureColor,
} from "~/features/products/category-theme";

/**
 * The manifest's feature roster (labels and descriptions) with each
 * feature's icon and chart color, so the pill matches every other place a
 * category is drawn.
 */
export const productCategoryFeatureOptions = () =>
  (
    entityFieldModel("productCategory").fields.find(
      (field) => field.key === "feature",
    )?.control?.options ?? []
  ).map((option) => {
    const Icon = getCategoryIcon(option.value);
    return { ...option, icon: <Icon />, color: getFeatureColor(option.value) };
  });
