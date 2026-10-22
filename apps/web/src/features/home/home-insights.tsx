import type { CookbookShortcode } from "@cubby/schemas/identifiers";
import { useState } from "react";

import { IngredientUsagePanel } from "~/features/ingredient/ingredient-usage-panel";
import { HierarchySunburst } from "~/features/product-category/hierarchy-view";
import { CookbookSelect } from "~/features/recipe/cookbook-select";
import { Grid, Stack } from "~/ui/layout";
import { Section } from "~/ui/layout";
import IngredientNetwork from "~/ui/visualizations/ingredient-network";

/** Exploration-only visualizations, requested only when Insights opens. */
export function HomeInsights() {
  return (
    <Grid cols="pair" gap="md">
      <Section
        headingAs="h3"
        title="Which categories hold our products?"
        caption="Distribution across categories; expand counts for record links."
      >
        <HierarchySunburst entity="productCategory" />
      </Section>
      <Section
        headingAs="h3"
        title="Where is our inventory?"
        caption="How owned-item counts are distributed across your locations."
      >
        <HierarchySunburst entity="location" />
      </Section>
      <Section
        headingAs="h3"
        title="Which ingredients travel together?"
        caption="Ingredients that co-occur across recipes; larger nodes are used more."
      >
        <IngredientNetwork />
      </Section>
      <Section
        headingAs="h3"
        title="Which ingredients power our recipes?"
        caption="How many recipes use each ingredient; scope by cookbook."
      >
        <IngredientUsageSection />
      </Section>
    </Grid>
  );
}

function IngredientUsageSection() {
  const [cookbookId, setCookbookId] = useState<CookbookShortcode | undefined>();
  return (
    <Stack>
      <CookbookSelect value={cookbookId} onChange={setCookbookId} />
      <IngredientUsagePanel cookbookId={cookbookId} limit={12} />
    </Stack>
  );
}
