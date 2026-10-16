import type { CookbookShortcode } from "@cubby/schemas/identifiers";
import { ChartPieIcon } from "@phosphor-icons/react/dist/csr/ChartPie";
import { ListChecksIcon } from "@phosphor-icons/react/dist/csr/ListChecks";
import { MapPinIcon } from "@phosphor-icons/react/dist/csr/MapPin";
import { ShareNetworkIcon } from "@phosphor-icons/react/dist/csr/ShareNetwork";
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
        icon={<ChartPieIcon />}
        title="Which categories hold our products?"
        description="Distribution across categories — click a ring to open one."
      >
        <HierarchySunburst entity="productCategory" />
      </Section>
      <Section
        headingAs="h3"
        icon={<MapPinIcon />}
        title="Where is our inventory?"
        description="How owned-item counts are distributed across your locations."
      >
        <HierarchySunburst entity="location" />
      </Section>
      <Section
        headingAs="h3"
        icon={<ShareNetworkIcon />}
        title="Which ingredients travel together?"
        description="Ingredients that co-occur across recipes; larger nodes are used more."
      >
        <IngredientNetwork />
      </Section>
      <Section
        headingAs="h3"
        icon={<ListChecksIcon />}
        title="Which ingredients power our recipes?"
        description="How many recipes use each ingredient; scope by cookbook."
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
