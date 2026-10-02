import type { MealFilters, MealOut } from "@cubby/schemas/meal";
import { useMemo } from "react";

import { mealDateLabel } from "~/app/meals/meal-format";
import { entityMutationOptionsFactory } from "~/entity/entity-contracts";
import { useDeletableConfig } from "~/ui/hooks/useDeletableConfig";
import { useUpdateMutation } from "~/ui/hooks/useUpdateMutation";

import { defineListOverride } from "./types";

export function mealNameUpdate(newName: string) {
  return { name: newName.trim() || null };
}

/**
 * The `/meals?view=table` surface: inline rename/reschedule, delete (row +
 * bulk). Cost stays unsortable on purpose: it is a read-time rollup of
 * `recipe.totals x scale` summed through the estimate engine, and a SQL
 * ORDER BY cannot preserve partial/pending/unavailable semantics.
 */
export const mealListOverride = defineListOverride<MealOut, MealFilters>({
  use() {
    const updateMealMutation = useUpdateMutation({
      mutationFn: entityMutationOptionsFactory("meal", "update"),
      entity: "meal",
    });
    // NOT `useNameEditable` — it hardcodes `{ name: newName }`, which would
    // persist `""` on a cleared name and defeat the date fallback (an empty
    // edit must write `null`).
    const nameEditable = useMemo(
      () => ({
        onSave: async (newName: string, meal: MealOut) => {
          await updateMealMutation.mutateAsync({
            id: meal.id,
            data: mealNameUpdate(newName),
          });
        },
        getValue: (meal: MealOut) => meal.name,
      }),
      // oxlint-disable-next-line react/exhaustive-deps -- The fresh wrapper is intentionally excluded; stable semantic members govern this hook.
      [updateMealMutation.mutateAsync],
    );
    const deletable = useDeletableConfig({
      mutationFn: entityMutationOptionsFactory("meal", "delete"),
      entityLabel: "Meal",
      entity: "meal",
    });

    const list = useMemo(
      () => ({
        deletable,
        nameClassName: "w-56",
        nameEditable,
        // Same fallback the Name column uses, so the confirm dialog names an
        // unnamed meal by its date instead of its id.
        deleteEmptyLabel: mealDateLabel,
      }),
      [deletable, nameEditable],
    );
    return { list };
  },
});
