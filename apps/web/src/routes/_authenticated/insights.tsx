import { unsafeCookbookId } from "@cubby/schemas/identifiers";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { IngredientUsagePanel } from "~/app/_components/ingredient/ingredient-usage-panel";
import { CategoryAudit } from "~/app/_components/insights/category-audit";
import LocationTreemap from "~/app/_components/inventory/location-treemap";
import IngredientNetwork from "~/app/_components/visualizations/ingredient-network";
import LocationSunburst from "~/app/_components/visualizations/location-sunburst";
import ProductCategoryDonut from "~/app/_components/visualizations/product-category-donut";
import { Grid, Row, Section, Stack } from "~/components/layout";
import { Page } from "~/components/page/Page";
import { useTRPC } from "~/trpc/react";

export const Route = createFileRoute("/_authenticated/insights")({
  component: InsightsPage,
});

function InsightsPage() {
  return (
    <Page variant="list" title="Insights">
      <Stack>
        <Section
          title="Products by Category"
          description="Distribution of products across categories. Click a slice to view products in that category."
        >
          <ProductCategoryDonut />
        </Section>

        <Section title="Inventory by Location">
          <Grid cols="pair">
            <Stack gap="sm">
              <h3 className="font-medium text-muted-foreground text-sm">
                Treemap View
              </h3>
              <LocationTreemap />
            </Stack>
            <Stack gap="sm">
              <h3 className="font-medium text-muted-foreground text-sm">
                Sunburst View
              </h3>
              <LocationSunburst />
            </Stack>
          </Grid>
        </Section>

        <Section
          title="Ingredient Relationships"
          description="Ingredients that appear together in multiple recipes are connected. Larger nodes indicate ingredients used in more recipes."
        >
          <IngredientNetwork />
        </Section>

        <Section
          title="Ingredient Usage"
          description="How many recipes use each ingredient. Scope to a cookbook, and merge near-duplicate names inline."
        >
          <IngredientUsageSection />
        </Section>

        <Section
          title="Category Audit"
          description="Use AI to analyze your product catalog and suggest new categories that could better organize your inventory."
        >
          <CategoryAudit />
        </Section>
      </Stack>
    </Page>
  );
}

function IngredientUsageSection() {
  const api = useTRPC();
  const { data: cookbooks } = useQuery(api.recipe.listCookbooks.queryOptions());
  const [cookbookId, setCookbookId] = useState<string>("");

  return (
    <Stack>
      <Row as="label" align="center" gap="sm" className="w-fit text-sm">
        <span className="text-muted-foreground">Cookbook</span>
        <select
          className="h-8 rounded-md border bg-background px-2 text-sm"
          value={cookbookId}
          onChange={(e) => setCookbookId(e.target.value)}
        >
          <option value="">All cookbooks</option>
          {cookbooks?.map((c) => (
            <option key={c.id} value={c.id}>
              {c.book}
            </option>
          ))}
        </select>
      </Row>
      <IngredientUsagePanel
        cookbookId={cookbookId ? unsafeCookbookId(cookbookId) : undefined}
      />
    </Stack>
  );
}
