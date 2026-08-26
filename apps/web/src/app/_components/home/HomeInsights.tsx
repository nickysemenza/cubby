import type { CookbookShortcode } from "@cubby/schemas/identifiers";
import { ListChecks, MapPin, PieChart, Share2 } from "lucide-react";
import { useState } from "react";
import { IngredientUsagePanel } from "~/app/_components/ingredient/ingredient-usage-panel";
import { CookbookSelect } from "~/app/_components/recipe/cookbook-select";
import IngredientNetwork from "~/app/_components/visualizations/ingredient-network";
import LocationSunburst from "~/app/_components/visualizations/location-sunburst";
import ProductCategoryDonut from "~/app/_components/visualizations/product-category-donut";
import { Grid, Stack } from "~/components/layout";
import { DashboardCard } from "~/components/layout/dashboard-card";

/** Exploration-only visualizations, requested only when Insights opens. */
export function HomeInsights() {
  return (
    <Grid cols="pair" gap="md">
      <DashboardCard
        icon={PieChart}
        title="Products by category"
        description="Distribution across categories — click a slice to view products."
      >
        <ProductCategoryDonut />
      </DashboardCard>
      <DashboardCard
        icon={MapPin}
        title="Inventory by location"
        description="Where inventory value sits across your locations."
      >
        <LocationSunburst />
      </DashboardCard>
      <DashboardCard
        icon={Share2}
        title="Ingredient relationships"
        description="Ingredients that co-occur across recipes; larger nodes are used more."
      >
        <IngredientNetwork />
      </DashboardCard>
      <DashboardCard
        icon={ListChecks}
        title="Ingredient usage"
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
