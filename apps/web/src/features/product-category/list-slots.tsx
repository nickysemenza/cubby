import type { ListSlotId } from "@cubby/schemas/entity-manifest";

import type { ListSlotComponent } from "~/entity/entity-list/list-slot-types";
import { CategoryMappingWorkspace } from "~/features/product-category/mapping-workspace";

const ProductCategoryHierarchySlot: ListSlotComponent = () => (
  <CategoryMappingWorkspace />
);

export const productCategoryListSlots = {
  hierarchy: ProductCategoryHierarchySlot,
} satisfies Record<ListSlotId<"productCategory">, ListSlotComponent>;
