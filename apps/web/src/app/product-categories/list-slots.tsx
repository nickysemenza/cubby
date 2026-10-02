import type { ListSlotId } from "@cubby/schemas/entity-manifest";

import type { ListSlotComponent } from "~/entity/entity-list/list-slot-types";
import { HierarchyView } from "~/ui/visualizations/hierarchy-view";

const ProductCategoryHierarchySlot: ListSlotComponent = () => (
  <HierarchyView entity="productCategory" />
);

export const productCategoryListSlots = {
  hierarchy: ProductCategoryHierarchySlot,
} satisfies Record<ListSlotId<"productCategory">, ListSlotComponent>;
