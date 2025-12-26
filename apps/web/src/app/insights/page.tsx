import { BarChart3 } from "lucide-react";
import LocationTreemap from "../_components/inventory/location-treemap";
import LocationSunburst from "../_components/visualizations/location-sunburst";
import IngredientNetwork from "../_components/visualizations/ingredient-network";

export default function InsightsPage() {
  return (
    <div className="container mx-auto space-y-8 py-6">
      <div className="flex items-center gap-3">
        <BarChart3 className="h-8 w-8" />
        <h1 className="font-bold text-3xl">Insights</h1>
      </div>

      {/* Inventory by Location Section */}
      <section className="space-y-4">
        <h2 className="font-semibold text-xl">Inventory by Location</h2>
        <div className="grid gap-6 lg:grid-cols-2">
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
        <h2 className="font-semibold text-xl">Ingredient Relationships</h2>
        <p className="text-muted-foreground text-sm">
          Ingredients that appear together in multiple recipes are connected.
          Larger nodes indicate ingredients used in more recipes.
        </p>
        <IngredientNetwork />
      </section>
    </div>
  );
}
