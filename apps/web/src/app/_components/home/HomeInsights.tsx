import type { CookbookShortcode } from "@cubby/schemas/identifiers";
import { ChartPieIcon } from "@phosphor-icons/react/dist/csr/ChartPie";
import { ListChecksIcon } from "@phosphor-icons/react/dist/csr/ListChecks";
import { MapPinIcon } from "@phosphor-icons/react/dist/csr/MapPin";
import { ShareNetworkIcon } from "@phosphor-icons/react/dist/csr/ShareNetwork";
import { useState } from "react";

import { IngredientUsagePanel } from "~/app/_components/ingredient/ingredient-usage-panel";
import { CookbookSelect } from "~/app/_components/recipe/cookbook-select";
import { HierarchySunburst } from "~/app/_components/visualizations/hierarchy-view";
import IngredientNetwork from "~/app/_components/visualizations/ingredient-network";
import { Grid, Stack } from "~/components/layout";
import { DashboardCard } from "~/components/layout/dashboard-card";

/** Exploration-only visualizations, requested only when Insights opens. */
export function HomeInsights() {
  return (
    <Grid cols="pair" gap="md">
      <DashboardCard
        icon={ChartPieIcon}
        title="Which categories hold our products?"
        description="Distribution across categories — click a ring to open one."
      >
        <HierarchySunburst entity="productCategory" />
      </DashboardCard>
      <DashboardCard
        icon={MapPinIcon}
        title="Where is our inventory?"
        description="How owned-item counts are distributed across your locations."
      >
        <HierarchySunburst entity="location" />
      </DashboardCard>
      <DashboardCard
        icon={ShareNetworkIcon}
        title="Which ingredients travel together?"
        description="Ingredients that co-occur across recipes; larger nodes are used more."
      >
        <IngredientNetwork />
      </DashboardCard>
      <DashboardCard
        icon={ListChecksIcon}
        title="Which ingredients power our recipes?"
        description="How many recipes use each ingredient; scope by cookbook."
      >
        <IngredientUsageSection />
      </DashboardCard>
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
