"use client";

import React, { useMemo, useState } from "react";
import { useAsyncMemo } from "~/hooks/useAsyncMemo";
import { SectionIngredientOut, type RecipeOut } from "~/schemas/recipe";
import { RecipeIngredientList } from "./recipeingredientlist";
import { type IngredientWithFoodOut } from "~/server/services/ingredient.service";
import EntityImageList from "../EntityImageList";
import { useTRPCClient } from "~/trpc/react";
import { AuditLogList } from "../audit-log/audit-log-list";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { RecipeMagazineView } from "./RecipeMagazineView";
import { NYTView } from "./NYTView";
import { Button } from "~/components/ui/button";
import { Table2, BookOpen, Newspaper } from "lucide-react";

type ViewMode = "magazine" | "nyt" | "table";

const RecipeDetail: React.FC<{
  recipe: RecipeOut;
}> = ({ recipe }) => {
  const trpcClient = useTRPCClient();
  const [viewMode, setViewMode] = useState<ViewMode>("magazine");

  const ingredients: SectionIngredientOut[] = useMemo(
    () =>
      recipe.sections.flatMap((section) =>
        section.ingredients.flatMap((i) => i),
      ),
    [recipe.sections],
  );

  // Get recipe images from the recipe object
  const recipeImages = recipe.images;

  // Load ingredient data asynchronously (for table view)
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

      {/* Additional Images (for magazine view, if more than hero) */}
      {viewMode === "magazine" && recipeImages.length > 1 && (
        <Card>
          <CardHeader className="bg-muted/50 px-4 py-3">
            <CardTitle className="text-base font-medium">More Images</CardTitle>
          </CardHeader>
          <CardContent className="p-4">
            <EntityImageList images={recipeImages.slice(1)} />
          </CardContent>
        </Card>
      )}

      {/* History Section */}
      <Card>
        <CardHeader className="bg-muted/50 px-4 py-3">
          <CardTitle className="text-base font-medium">History</CardTitle>
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
