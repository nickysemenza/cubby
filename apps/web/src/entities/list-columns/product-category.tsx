import type {
  ProductCategoryFilters,
  ProductCategoryOut,
} from "@cubby/schemas/product-category";
import { useMemo } from "react";

import {
  type CategoryTreeRow,
  nestProductCategories,
  productCategorySubRows,
} from "~/app/product-categories/category-tree";

import { defineListOverride } from "./types";

type ProductCategoryRow = CategoryTreeRow<ProductCategoryOut>;

const PRODUCT_CATEGORY_TREE = {
  nest: nestProductCategories<ProductCategoryOut>,
  getSubRows: productCategorySubRows<ProductCategoryOut>,
  expandable: true,
} as const;

/** Nesting already shows each row's parent. */
const PRODUCT_CATEGORY_INITIAL_COLUMN_VISIBILITY = { parentName: false };

export const productCategoryListOverride = defineListOverride<
  ProductCategoryRow,
  ProductCategoryFilters,
  ProductCategoryOut
>({
  use() {
    const list = useMemo(
      () => ({
        deletable: true as const,
        initialColumnVisibility: PRODUCT_CATEGORY_INITIAL_COLUMN_VISIBILITY,
      }),
      [],
    );
    return { tree: PRODUCT_CATEGORY_TREE, list };
  },
});
