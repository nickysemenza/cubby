import { createFileRoute } from "@tanstack/react-router";
import { CategoryAudit } from "~/app/_components/insights/category-audit";
import LocationTreemap from "~/app/_components/inventory/location-treemap";
import IngredientNetwork from "~/app/_components/visualizations/ingredient-network";
import LocationSunburst from "~/app/_components/visualizations/location-sunburst";
import ProductCategoryDonut from "~/app/_components/visualizations/product-category-donut";
import { PageHero } from "~/components/layouts/page-hero";

export const Route = createFileRoute("/_authenticated/insights")({
  component: InsightsPage,
});

function InsightsPage() {
  return (
    <div className="fade-in container mx-auto animate-in space-y-4 py-6 duration-300">
      <PageHero variant="list" title="Insights" />

      {/* Products by Category Section */}
      <section className="space-y-4">
        <h2 className="font-heading font-semibold text-xl">
          Products by Category
        </h2>
        <p className="text-muted-foreground text-sm">
          Distribution of products across categories. Click a slice to view
          products in that category.
        </p>
        <ProductCategoryDonut />
      </section>

      {/* Inventory by Location Section */}
      <section className="space-y-4">
        <h2 className="font-heading font-semibold text-xl">
          Inventory by Location
        </h2>
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-2">
            <h3 className="font-medium text-muted-foreground text-sm">
              Treemap View
            </h3>
            <LocationTreemap />
          </div>
          <div className="space-y-2">
            <h3 className="font-medium text-muted-foreground text-sm">
              Sunburst View
            </h3>
            <LocationSunburst />
          </div>
        </div>
      </section>

      {/* Ingredient Relationships Section */}
      <section className="space-y-4">
        <h2 className="font-heading font-semibold text-xl">
          Ingredient Relationships
        </h2>
        <p className="text-muted-foreground text-sm">
          Ingredients that appear together in multiple recipes are connected.
          Larger nodes indicate ingredients used in more recipes.
        </p>
        <IngredientNetwork />
      </section>

      {/* Category Audit Section */}
      <section className="space-y-4">
        <h2 className="font-heading font-semibold text-xl">Category Audit</h2>
        <p className="text-muted-foreground text-sm">
          Use AI to analyze your product catalog and suggest new categories that
          could better organize your inventory.
        </p>
        <CategoryAudit />
      </section>
    </div>
  );
}
