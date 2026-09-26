import type { ListSlotId } from "@cubby/schemas/entity-manifest";

import type { ListSlotComponent } from "~/app/_components/entity-list/list-slot-types";
import { HierarchyView } from "~/app/_components/visualizations/hierarchy-view";

const ProductCategoryHierarchySlot: ListSlotComponent = () => (
  <HierarchyView entity="productCategory" />
);

export const productCategoryListSlots = {
  hierarchy: ProductCategoryHierarchySlot,
} satisfies Record<ListSlotId<"productCategory">, ListSlotComponent>;
