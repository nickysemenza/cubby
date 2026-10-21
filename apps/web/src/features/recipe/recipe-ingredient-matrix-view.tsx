import { memo } from "react";

import { Panel } from "~/ui/layout";

import { formatYield } from "../../entity/presentation/recipe-yield";
import { IngredientComponentGrid } from "./ingredient-component-grid";
import type { RecipeTreeNode } from "./recipe-tree";

// The standalone ingredient × component matrix, used by the print/export sheet.
// The grid itself lives in the shared {@link IngredientComponentGrid} (also used
// by the Prep view's grid sub-mode); this wraps it in the export card + header.

// memo: skip re-renders from streaming churn (`tree` is stable).
export const RecipeIngredientMatrixView = memo(
  function RecipeIngredientMatrixView({ tree }: { tree: RecipeTreeNode }) {
    const recipe = tree.recipe;
    return (
      <Panel tone="default" className="space-y-4 p-4 sm:p-6">
        <header className="mb-4 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
          <div>
            <h2 className="my-0 font-heading text-2xl font-semibold tracking-tight">
              {recipe.name}
            </h2>
            <span className="eyebrow">Ingredient × component</span>
          </div>
          {recipe.yield?.value ? (
            <span className="font-heading text-sm text-primary">
              Yields {formatYield(recipe.yield)}
            </span>
          ) : null}
        </header>

        <IngredientComponentGrid tree={tree} />
      </Panel>
    );
  },
);
