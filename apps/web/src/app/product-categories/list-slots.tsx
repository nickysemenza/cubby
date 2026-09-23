import type { ListSlotId } from "@cubby/schemas/entity-manifest";

import type { ListSlotComponent } from "~/app/_components/entity-list/list-slot-types";
import ProductCategorySunburst from "~/app/_components/visualizations/product-category-sunburst";
import ProductCategoryTreeGraph from "~/app/_components/visualizations/product-category-tree-graph";
import { VisualizationPanel } from "~/app/_components/visualizations/visualization-panel";
import { SimpleLoading } from "~/components/feedback/loading-skeletons";
import { Grid } from "~/components/layout";

/** Structure (every category) beside weight (where products concentrate). */
const ProductCategoryHierarchySlot: ListSlotComponent = () => (
  <Grid cols="pair">
    <VisualizationPanel
      title="Category tree"
      description="Root, group, and type. Each count includes the products in every category below it; hollow dots have none."
      fallback={<SimpleLoading text="Loading tree..." />}
    >
      <ProductCategoryTreeGraph />
    </VisualizationPanel>
    <VisualizationPanel
      title="Products by category"
      description="Rings go one level deeper each, sized by product count and colored by feature."
      fallback={<SimpleLoading text="Loading sunburst..." />}
    >
      <ProductCategorySunburst />
    </VisualizationPanel>
  </Grid>
);

export const productCategoryListSlots = {
  hierarchy: ProductCategoryHierarchySlot,
} satisfies Record<ListSlotId<"productCategory">, ListSlotComponent>;
