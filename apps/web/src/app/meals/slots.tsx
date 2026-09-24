import type {
  MealShortcode,
  RecipeShortcode,
} from "@cubby/schemas/identifiers";
import type { MealRecipeOut } from "@cubby/schemas/meal";
import { MEAL_KIND_LABELS } from "@cubby/schemas/meal-classification";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { TrashIcon } from "@phosphor-icons/react/dist/csr/Trash";
import type { QueryKey } from "@tanstack/react-query";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";

import { StaticPicker } from "~/app/_components/combobox/static-picker";
import type { DetailSlotComponent } from "~/app/_components/entity-detail/detail-slots";
import { showErrorToast } from "~/components/feedback/error-details";
import { SimpleLoading } from "~/components/feedback/loading-skeletons";
import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { Description } from "~/components/ui/description";
import { DialogFooter } from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { ResponsiveDialog } from "~/components/ui/responsive-dialog";
import { entityDetailLink } from "~/entities/entities";
import { entityDetailFor } from "~/entities/entity-detail.functions";
import type { EntityDetailByEntity } from "~/entities/generated/entity-details.gen";

import { AddFoodDialog } from "./add-food-dialog";
import { formatCostEstimate } from "./meal-nutrition";
import { MealNutritionSummary } from "./meal-nutrition-summary";
import { MealPortionsSection } from "./meal-preparation/meal-portions-section";
import { PortionSheet } from "./meal-preparation/portion-sheet";
import { RecipeFoodDialog } from "./meal-preparation/recipe-food-dialog";
import { useMealPreparationController } from "./meal-preparation/use-meal-preparation-controller";
import { meal as mealOperations } from "./meal.functions";
import { useInvalidateMeals } from "./use-meal-mutations";

type MealDetail = EntityDetailByEntity["meal"];

function recipeOrdinal(
  recipes: MealRecipeOut[],
  recipeId: string,
  index: number,
): number | null {
  const matches = recipes.filter((recipe) => recipe.recipeId === recipeId);
  if (matches.length < 2) return null;
  return (
    recipes.slice(0, index).filter((recipe) => recipe.recipeId === recipeId)
      .length + 1
  );
}

/**
 * The meal's recipes with per-row scale/remove, the "Add food" capture and
 * the preparation (portions) workflow those rows open.
 */
export const MealComposition: DetailSlotComponent<"meal"> = ({
  record: meal,
}) => {
  const mealId = meal.id;
  const invalidate = useInvalidateMeals();
  const mealKey = entityDetailFor("meal").queryKey(mealId);
  const [addFoodOpen, setAddFoodOpen] = useState(false);
  const [recipeFoodId, setRecipeFoodId] = useState<RecipeShortcode | null>(
    null,
  );
  const preparation = useMealPreparationController({
    mealId,
    mealDate: meal.date,
    invalidate,
  });
  const preparationView = preparation.view;
  return (
    <Stack gap="md">
      <Row justify="end">
        <Button type="button" size="sm" onClick={() => setAddFoodOpen(true)}>
          <PlusIcon className="size-4" />
          Add food
        </Button>
      </Row>
      <Stack gap="sm">
        {meal.recipes.length === 0 ? (
          <Description>
            {meal.mealKind === "cooked"
              ? "No recipes yet. Add food when you're ready to plan or log this meal."
              : meal.mealKind === "leftovers"
                ? "No new recipes. Add leftovers from another meal below."
                : `${MEAL_KIND_LABELS[meal.mealKind]} — no recipe required.`}
          </Description>
        ) : (
          meal.recipes.map((mr, index) => (
            <RecipeRow
              key={mr.id}
              mr={mr}
              ordinal={recipeOrdinal(meal.recipes, mr.recipeId, index)}
              onOpenPreparation={
                preparationView
                  ? (mealRecipeId) =>
                      preparation.openCurrentPreparation(mealRecipeId)
                  : undefined
              }
              mealKey={mealKey}
              onChanged={invalidate}
            />
          ))
        )}
      </Stack>
      {preparationView ? (
        <MealPortionsSection
          view={preparationView}
          onAddPreparedPortion={preparation.beginAddPreparedPortion}
          onEditPreparation={preparation.openCurrentPreparation}
        />
      ) : null}
      <MealPreparationOverlays
        preparation={preparation}
        currentMealId={mealId}
      />
      <AddFoodDialog
        mealId={mealId}
        date={meal.date}
        open={addFoodOpen}
        onOpenChange={setAddFoodOpen}
        onRecipe={(recipeId) => {
          setAddFoodOpen(false);
          setRecipeFoodId(recipeId);
        }}
      />
      <RecipeFoodDialog
        mealId={mealId}
        date={meal.date}
        recipeId={recipeFoodId}
        onClose={() => setRecipeFoodId(null)}
      />
    </Stack>
  );
};

/** Nutrition by person; editing a recipe's portions opens the preparation sheet. */
export const MealNutrition: DetailSlotComponent<"meal"> = ({
  record: meal,
}) => {
  const invalidate = useInvalidateMeals();
  const preparation = useMealPreparationController({
    mealId: meal.id,
    mealDate: meal.date,
    invalidate,
  });
  return (
    <>
      <MealNutritionSummary
        mealId={meal.id}
        onEditRecipe={(mealRecipeId) =>
          preparation.openCurrentPreparation(mealRecipeId)
        }
      />
      <MealPreparationOverlays
        preparation={preparation}
        currentMealId={meal.id}
      />
    </>
  );
};

function MealPreparationOverlays({
  preparation,
  currentMealId,
}: {
  preparation: ReturnType<typeof useMealPreparationController>;
  currentMealId: MealShortcode;
}) {
  return (
    <>
      <ResponsiveDialog
        open={preparation.sourcePickerOpen}
        onOpenChange={preparation.setSourcePickerOpen}
        title="Add leftovers"
        description="Choose a recipe prepared in another recent meal, including another meal from the same day."
        footer={
          <DialogFooter className="gap-2 sm:justify-end">
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                preparation.setSourcePickerOpen(false);
                preparation.setSourceSelectionId(null);
              }}
            >
              Cancel
            </Button>
            <Button
              type="button"
              disabled={preparation.selectedSourceChoice == null}
              onClick={preparation.chooseSource}
            >
              Continue
            </Button>
          </DialogFooter>
        }
      >
        {preparation.isLoadingSourceChoices ? (
          <SimpleLoading text="Loading prepared recipes…" />
        ) : preparation.sourceChoices.length ? (
          <StaticPicker
            items={preparation.sourceChoices.map(({ value, label }) => ({
              value,
              label,
            }))}
            value={preparation.selectedSourceChoice?.value ?? null}
            onValueChange={preparation.setSourceSelectionId}
            label="Prepared recipe"
            placeholder="Choose a prepared recipe"
          />
        ) : (
          <Description>
            No prepared recipes are available from another recent meal.
          </Description>
        )}
      </ResponsiveDialog>
      {preparation.selectedPreparation ? (
        <PortionSheet
          source={preparation.selectedPreparation}
          currentMealId={currentMealId}
          targetMeals={preparation.targetMeals}
          eaters={preparation.eaters}
          open
          onOpenChange={(open) => {
            if (!open) preparation.closePreparation();
          }}
          isSaving={preparation.isSaving}
          onSave={preparation.save}
        />
      ) : null}
    </>
  );
}

function RecipeRow({
  mr,
  ordinal,
  onOpenPreparation,
  mealKey,
  onChanged,
}: {
  mr: MealRecipeOut;
  ordinal: number | null;
  onOpenPreparation?: (mealRecipeId: string) => void;
  mealKey: QueryKey;
  onChanged: () => void;
}) {
  const queryClient = useQueryClient();
  const [scale, setScale] = useState(String(mr.scale));

  const patchMeal = (patch: (meal: MealDetail) => MealDetail) => {
    queryClient.setQueryData<MealDetail | null>(mealKey, (current) =>
      current ? patch(current) : current,
    );
  };
  const updateBase = mealOperations.updateRecipe.mutationOptions();
  const updateRecipe = useMutation({
    ...updateBase,
    onMutate: async (variables) => {
      await queryClient.cancelQueries({ queryKey: mealKey });
      const previous = queryClient.getQueryData<MealDetail | null>(mealKey);
      patchMeal((meal) => ({
        ...meal,
        recipes: meal.recipes.map((recipe) =>
          recipe.id === variables.id
            ? { ...recipe, scale: variables.scale ?? recipe.scale }
            : recipe,
        ),
      }));
      return { previous };
    },
    onSuccess: (updated) => {
      queryClient.setQueryData(mealKey, updated);
      const reconciled = updated.recipes.find((recipe) => recipe.id === mr.id);
      if (reconciled) setScale(String(reconciled.scale));
    },
    onError: (error, _variables, context) => {
      if (context?.previous)
        queryClient.setQueryData(mealKey, context.previous);
      setScale(String(mr.scale));
      showErrorToast(error);
    },
    onSettled: onChanged,
  });
  const removeBase = mealOperations.removeRecipe.mutationOptions();
  const removeRecipe = useMutation({
    ...removeBase,
    onMutate: async (variables) => {
      await queryClient.cancelQueries({ queryKey: mealKey });
      const previous = queryClient.getQueryData<MealDetail | null>(mealKey);
      patchMeal((meal) => ({
        ...meal,
        recipes: meal.recipes.filter((recipe) => recipe.id !== variables.id),
      }));
      return { previous };
    },
    onSuccess: (updated) => {
      queryClient.setQueryData(mealKey, updated);
      toast.success(`Removed ${mr.recipe.name}`);
    },
    onError: (error, _variables, context) => {
      if (context?.previous)
        queryClient.setQueryData(mealKey, context.previous);
      showErrorToast(error);
    },
    onSettled: onChanged,
  });

  const commitScale = () => {
    const next = Number(scale);
    if (Number.isFinite(next) && next >= 0.01 && next !== mr.scale) {
      updateRecipe.mutate({ id: mr.id, scale: next });
    } else {
      setScale(String(mr.scale)); // reset invalid input
    }
  };

  return (
    <div className="rounded-md border border-[var(--border)] px-3 py-2">
      <Row align="center" justify="between" gap="sm">
        <Link
          {...entityDetailLink("recipe", mr.recipe.id)}
          className="min-w-0 flex-1 truncate text-sm font-medium hover:underline"
          title={mr.recipe.name}
        >
          {mr.recipe.name}
          {ordinal ? ` · ${ordinal}` : null}
        </Link>
        {onOpenPreparation ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onOpenPreparation(mr.id)}
          >
            Edit portions
          </Button>
        ) : null}
      </Row>
      <details className="text-xs">
        <summary className="min-h-10 cursor-pointer content-center text-muted-foreground hover:text-foreground">
          Planning details
        </summary>
        <Row
          align="center"
          justify="between"
          gap="sm"
          wrap
          className="border-t pt-2"
        >
          <Row align="center" gap="xs">
            <span className="text-muted-foreground">Recipe scale</span>
            <Input
              type="number"
              step={0.25}
              min={0.01}
              value={scale}
              className="h-9 w-20 text-right tabular-nums"
              onChange={(e) => setScale(e.target.value)}
              onBlur={commitScale}
              aria-label="Recipe scale"
            />
            <span className="text-muted-foreground">×</span>
          </Row>
          <Row align="center" gap="sm">
            <span className="text-muted-foreground tabular-nums">
              {formatCostEstimate(mr.scaledTotals)}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={`Remove ${mr.recipe.name}`}
              disabled={removeRecipe.isPending}
              onClick={() => removeRecipe.mutate({ id: mr.id })}
            >
              <TrashIcon className="size-4" />
              Remove
            </Button>
          </Row>
        </Row>
      </details>
    </div>
  );
}
