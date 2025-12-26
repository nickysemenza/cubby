"use client";

import type React from "react";
import { useMemo, useState } from "react";
import { useAsyncMemo } from "~/hooks/useAsyncMemo";
import type { SectionIngredientOut, RecipeOut } from "~/schemas/recipe";
import { RecipeIngredientList } from "./recipeingredientlist";
import type { IngredientWithFoodOut } from "~/server/services/ingredient.service";
import EntityImageList from "../EntityImageList";
import { useTRPCClient } from "~/trpc/react";
import { AuditLogList } from "../audit-log/audit-log-list";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { RecipeMagazineView } from "./RecipeMagazineView";
import { NYTView } from "./NYTView";
import { Button } from "~/components/ui/button";
import { Table2, BookOpen, Newspaper, BarChart3 } from "lucide-react";
import {
  createIngredientData,
  calculateTotals,
  type IngredientDataItem,
} from "~/app/_components/units/univ-conversion";
import RecipeCostTreemap from "~/app/_components/visualizations/recipe-cost-treemap";
import MacroSunburst from "~/app/_components/visualizations/macro-sunburst";
import { getIngredientName } from "./recipeutils";

type ViewMode = "magazine" | "nyt" | "table" | "charts";

const RecipeDetail: React.FC<{
  recipe: RecipeOut;
}> = ({ recipe }) => {
  const trpcClient = useTRPCClient();
  const [viewMode, setViewMode] = useState<ViewMode>("magazine");

  const ingredients: SectionIngredientOut[] = useMemo(
    () => recipe.sections.flatMap((section) => section.ingredients.flat()),
    [recipe.sections],
  );

  // Get recipe images from the recipe object
  const recipeImages = recipe.images;

  // Load ingredient data asynchronously (for table and charts views)
  const data = useAsyncMemo(
    async () => {
      const ids = ingredients
        .filter((i) => i.type === "ingredient")
        .map((i) => i.ingredient.id);

      const ingredientsArray: IngredientWithFoodOut[] = await Promise.all(
        ids.map((id) => trpcClient.ingredient.getByID.query({ id })),
      );

      return ingredientsArray.reduce(
        (acc, ingredient) => {
          acc[ingredient.id] = ingredient;
          return acc;
        },
        {} as Record<string, IngredientWithFoodOut>,
      );
    },
    [ingredients, trpcClient.ingredient.getByID],
    undefined,
  );

  // Load enriched ingredient data for charts (with price/nutrition info)
  const ingredientDataItems = useAsyncMemo(
    async () => (data ? createIngredientData(ingredients, data) : []),
    [ingredients, data],
    [] as IngredientDataItem[],
  );

  // Calculate totals for charts
  const totals = useAsyncMemo(
    async () =>
      data ? calculateTotals(ingredients, data, getIngredientName) : null,
    [ingredients, data],
    null,
  );

  return (
    <div className="space-y-6">
      {/* View Toggle */}
      <div className="flex justify-end gap-2">
        <Button
          variant={viewMode === "magazine" ? "default" : "outline"}
          size="sm"
          onClick={() => setViewMode("magazine")}
        >
          <BookOpen className="mr-2 h-4 w-4" />
          Magazine
        </Button>
        <Button
          variant={viewMode === "nyt" ? "default" : "outline"}
          size="sm"
          onClick={() => setViewMode("nyt")}
        >
          <Newspaper className="mr-2 h-4 w-4" />
          NYT
        </Button>
        <Button
          variant={viewMode === "table" ? "default" : "outline"}
          size="sm"
          onClick={() => setViewMode("table")}
        >
          <Table2 className="mr-2 h-4 w-4" />
          Table
        </Button>
        <Button
          variant={viewMode === "charts" ? "default" : "outline"}
          size="sm"
          onClick={() => setViewMode("charts")}
        >
          <BarChart3 className="mr-2 h-4 w-4" />
          Charts
        </Button>
      </div>

      {/* View Components */}
      {viewMode === "magazine" && <RecipeMagazineView recipe={recipe} />}
      {viewMode === "nyt" && <NYTView recipe={recipe} />}
      {viewMode === "table" && (
        <>
          {/* Images for table view */}
          {recipeImages.length > 0 && (
            <div className="mb-6">
              <EntityImageList images={recipeImages} title="Recipe Images" />
            </div>
          )}
          <RecipeIngredientList ingredients={ingredients} ingMap={data} />
        </>
      )}
      {viewMode === "charts" && (
        <div className="space-y-6">
          <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader className="bg-muted/50 px-4 py-3">
                <CardTitle className="font-medium text-base">
                  Cost Breakdown
                </CardTitle>
              </CardHeader>
              <CardContent className="p-4">
                {ingredientDataItems.length > 0 ? (
                  <RecipeCostTreemap
                    ingredients={ingredientDataItems}
                    totalCost={totals?.price ?? 0}
                  />
                ) : (
                  <div className="flex h-[300px] items-center justify-center text-muted-foreground">
                    Loading...
                  </div>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="bg-muted/50 px-4 py-3">
                <CardTitle className="font-medium text-base">
                  Nutrition Breakdown
                </CardTitle>
              </CardHeader>
              <CardContent className="p-4">
                {ingredientDataItems.length > 0 ? (
                  <MacroSunburst ingredients={ingredientDataItems} />
                ) : (
                  <div className="flex h-[300px] items-center justify-center text-muted-foreground">
                    Loading...
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      )}

      {/* Additional Images (for magazine view, if more than hero) */}
      {viewMode === "magazine" && recipeImages.length > 1 && (
        <Card>
          <CardHeader className="bg-muted/50 px-4 py-3">
            <CardTitle className="font-medium text-base">More Images</CardTitle>
          </CardHeader>
          <CardContent className="p-4">
            <EntityImageList images={recipeImages.slice(1)} />
          </CardContent>
        </Card>
      )}

      {/* History Section */}
      <Card>
        <CardHeader className="bg-muted/50 px-4 py-3">
          <CardTitle className="font-medium text-base">History</CardTitle>
        </CardHeader>
        <CardContent className="p-4">
          <AuditLogList
            entityType="recipe"
            entityId={recipe.id}
            showEntityLink={false}
          />
        </CardContent>
      </Card>
    </div>
  );
};

export default RecipeDetail;
