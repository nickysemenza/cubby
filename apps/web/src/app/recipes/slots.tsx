import type { NutritionBasis } from "@cubby/schemas/nutrition";
import { PrinterIcon } from "@phosphor-icons/react/dist/csr/Printer";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";

import { AddToMeal } from "~/app/meals/add-to-meal";
import { DetailAction } from "~/entity/entity-detail/detail-action-context";
import type { DetailSlotComponent } from "~/entity/entity-detail/detail-hooks";
import { EntityReportSlot } from "~/entity/entity-detail/report-slot";
import { CopyRecipeParseButton } from "~/features/recipes/copy-corpus-button";
import RecipeDetail, {
  type RecipeViewMode,
} from "~/features/recipes/RecipeDetail";
import { RecipeFlowAction } from "~/features/recipes/RecipeFlowView";
import type { RecipeFlowLayoutMode } from "~/features/recipes/RecipeFlowView";
import { Row, Stack } from "~/ui/layout";
import { Button } from "~/ui/primitives/button";

/**
 * The cooking workflow: view switcher, scaling, nutrition basis, costing
 * coverage and the flow layout, all URL state on the recipe route (which
 * keeps `route.detail: null` for exactly those keys). Availability and the
 * record-level actions use the persistent detail header.
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
  const recipeView = view ?? "read";
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
      <DetailAction>
        <RecipeActions record={recipe} />
      </DetailAction>
      <EntityReportSlot slot="recipe.availability" id={recipe.id} />
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

export const RecipeActions: DetailSlotComponent<"recipe"> = ({
  record: recipe,
}) => {
  const { view, scale, nutritionBasis } = useSearch({
    from: "/_authenticated/recipes/$shortcode",
  });
  return (
    <Row gap="sm" wrap>
      <AddToMeal recipeId={recipe.id} recipeName={recipe.name} />
      <CopyRecipeParseButton recipe={recipe} />
      <RecipeFlowAction recipeId={recipe.id} />
      <Button
        variant="outline"
        render={
          <Link
            to="/recipes/$shortcode/export"
            params={{ shortcode: recipe.id }}
            search={{
              format:
                view === "spec"
                  ? "nested"
                  : view === "flow"
                    ? "flow"
                    : undefined,
              scale,
              nutritionBasis,
            }}
          />
        }
      >
        <PrinterIcon />
        Print / export
      </Button>
    </Row>
  );
};
