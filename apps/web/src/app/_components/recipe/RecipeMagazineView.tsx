"use client";

import { type RecipeOut } from "~/schemas/recipe";
import { RecipeHero } from "./RecipeHero";
import { RecipeInstructions } from "./RecipeInstructions";
import { RecipeIngredientsSidebar } from "./RecipeIngredientsSidebar";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";

interface RecipeMagazineViewProps {
  recipe: RecipeOut;
}

export function RecipeMagazineView({ recipe }: RecipeMagazineViewProps) {
  return (
    <div className="space-y-6">
      {/* Hero Section */}
      <RecipeHero recipe={recipe} />

      {/* Two Column Layout */}
      <div className="grid gap-8 lg:grid-cols-[300px_1fr]">
        {/* Ingredients Sidebar - Sticky on desktop */}
        <aside className="lg:sticky lg:top-20 lg:h-fit">
          <Card>
            <CardHeader className="bg-muted/50 px-4 py-3">
              <CardTitle className="text-base font-medium">
                Ingredients
              </CardTitle>
            </CardHeader>
            <CardContent className="p-4">
              <RecipeIngredientsSidebar recipe={recipe} />
            </CardContent>
          </Card>
        </aside>

        {/* Instructions - Main content */}
        <main>
          <Card>
            <CardHeader className="bg-muted/50 px-4 py-3">
              <CardTitle className="text-base font-medium">
                Instructions
              </CardTitle>
            </CardHeader>
            <CardContent className="p-6">
              <RecipeInstructions recipe={recipe} />
            </CardContent>
          </Card>
        </main>
      </div>
    </div>
  );
}
