import type {
  MealShortcode,
  RecipeShortcode,
} from "@cubby/schemas/identifiers";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useEffectEvent, useRef } from "react";
import { toast } from "sonner";

import { showErrorToast } from "~/components/feedback/error-details";
import { SimpleLoading } from "~/components/feedback/loading-skeletons";
import { ResponsiveDialog } from "~/components/ui/responsive-dialog";

import { meal as mealOperations } from "../meal.functions";
import { useInvalidateMeals } from "../use-meal-mutations";
import { PortionSheet } from "./portion-sheet";
import { useMealPreparationController } from "./use-meal-preparation-controller";

/**
 * Completes the Recipe branch of Add food: create one meal occurrence, then
 * immediately collect its portions. Keeping this state here lets the
 * meal detail and day view share the same complete interaction.
 */
export function RecipeFoodDialog({
  mealId,
  date,
  recipeId,
  onClose,
}: {
  mealId: MealShortcode;
  date: string;
  recipeId: RecipeShortcode | null;
  onClose: () => void;
}) {
  const invalidate = useInvalidateMeals();
  const attemptedRecipe = useRef<RecipeShortcode | null>(null);
  const controller = useMealPreparationController({
    mealId,
    mealDate: date,
    invalidate,
    onSaved: onClose,
  });
  const addRecipe = useMutation({
    ...mealOperations.addRecipe.mutationOptions(),
    onSuccess: async (updated, variables) => {
      const existingIds = new Set(
        controller.view?.preparations.map(
          (preparation) => preparation.mealRecipeId,
        ) ?? [],
      );
      const added = updated.recipes.find(
        (recipe) =>
          recipe.recipeId === variables.recipeId && !existingIds.has(recipe.id),
      );
      if (!added) {
        toast.error(
          "The recipe was added, but its portion editor could not open.",
        );
        invalidate();
        onClose();
        return;
      }
      await controller.refetchPreparations();
      controller.openCurrentPreparation(added.id);
      invalidate();
    },
    onError: (error) => {
      showErrorToast(error);
      onClose();
    },
  });
  const preparationsReady = controller.view != null;
  const beginRecipe = useEffectEvent((selectedRecipeId: RecipeShortcode) => {
    if (!preparationsReady || attemptedRecipe.current === selectedRecipeId)
      return;
    attemptedRecipe.current = selectedRecipeId;
    addRecipe.mutate({ mealId, recipeId: selectedRecipeId, scale: 1 });
  });
  const resetRecipe = useEffectEvent(() => {
    attemptedRecipe.current = null;
    controller.closePreparation();
  });

  useEffect(() => {
    if (recipeId == null) {
      resetRecipe();
      return;
    }
    beginRecipe(recipeId);
  }, [mealId, preparationsReady, recipeId]);

  const close = () => {
    controller.closePreparation();
    onClose();
  };

  return (
    <>
      <ResponsiveDialog
        open={recipeId != null && controller.selectedPreparation == null}
        onOpenChange={(open) => {
          if (!open && !addRecipe.isPending) close();
        }}
        title="Add recipe portions"
        description="Adding the recipe to this meal before recording who had how much."
      >
        <SimpleLoading text="Preparing portion editor…" />
      </ResponsiveDialog>
      {controller.selectedPreparation ? (
        <PortionSheet
          source={controller.selectedPreparation}
          currentMealId={mealId}
          targetMeals={controller.targetMeals}
          eaters={controller.eaters}
          open
          onOpenChange={(open) => {
            if (!open) close();
          }}
          isSaving={controller.isSaving}
          onSave={controller.save}
        />
      ) : null}
    </>
  );
}
