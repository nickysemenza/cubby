import type { NutritionBasis } from "@cubby/schemas/nutrition";
import { useNavigate, useSearch } from "@tanstack/react-router";

import type { DetailSlotComponent } from "~/app/_components/entity-detail/detail-slots";
import { CopyRecipeParseButton } from "~/app/_components/recipe/copy-corpus-button";
import { RecipeAvailabilityPanel } from "~/app/_components/recipe/RecipeAvailabilityPanel";
import RecipeDetail, {
  type RecipeViewMode,
  remapLegacyView,
} from "~/app/_components/recipe/RecipeDetail";
import type { RecipeFlowLayoutMode } from "~/app/_components/recipe/RecipeFlowView";
import { AddToMeal } from "~/app/meals/add-to-meal";
import { Row, Stack } from "~/components/layout";

/**
 * The cooking workflow: view switcher, scaling, nutrition basis, costing
 * coverage and the flow layout, all URL state on the recipe route (which
 * keeps `route.detail: null` for exactly those keys). Availability and the
 * add-to-meal / copy-parse actions ride along as the workflow's own toolbar.
 */
export const RecipeWorkflow: DetailSlotComponent<"recipe"> = ({
  record: recipe,
}) => {
  const {
    costingGap: openCostingGap,
    view,
    flowLayout,
    scale,
    nutritionBasis = "whole",
  } = useSearch({ from: "/_authenticated/recipes/$shortcode" });
  const navigate = useNavigate();
  const recipeView = remapLegacyView(view);
  const setRecipeView = (next: RecipeViewMode) => {
    // Keep the default ("read") out of the URL for clean links.
    void navigate({
      to: ".",
      search: (prev) => ({ ...prev, view: next === "read" ? undefined : next }),
    });
  };
  const setScale = (factor: number) => {
    // Strip the default (1×) so unscaled links stay clean.
    void navigate({
      to: ".",
      search: (prev) => ({ ...prev, scale: factor === 1 ? undefined : factor }),
    });
  };
  const setFlowLayout = (next: RecipeFlowLayoutMode) => {
    void navigate({
      to: ".",
      search: (prev) => ({ ...prev, flowLayout: next }),
    });
  };
  const setNutritionBasis = (basis: NutritionBasis) => {
    void navigate({
      to: ".",
      search: (previous) => ({
        ...previous,
        nutritionBasis: basis === "whole" ? undefined : basis,
      }),
    });
  };
  const setCostingGapOpen = (open: boolean) => {
    void navigate({
      to: ".",
      search: (prev) => ({ ...prev, costingGap: open ? true : undefined }),
      replace: !open,
    });
  };
  return (
    <Stack gap="md">
      <Row gap="sm" wrap justify="end">
        <AddToMeal recipeId={recipe.id} recipeName={recipe.name} />
        <CopyRecipeParseButton recipe={recipe} />
      </Row>
      <RecipeAvailabilityPanel recipeId={recipe.id} />
      <RecipeDetail
        recipe={recipe}
        openCostingGap={openCostingGap}
        onCostingGapOpenChange={setCostingGapOpen}
        view={recipeView}
        onViewChange={setRecipeView}
        nutritionBasis={nutritionBasis}
        onNutritionBasisChange={setNutritionBasis}
        scale={scale}
        onScaleChange={setScale}
        flowLayout={flowLayout}
        onFlowLayoutChange={setFlowLayout}
      />
    </Stack>
  );
};
