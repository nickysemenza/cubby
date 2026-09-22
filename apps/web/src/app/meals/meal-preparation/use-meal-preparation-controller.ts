import type { MealShortcode } from "@cubby/schemas/identifiers";
import type { MealOut } from "@cubby/schemas/meal";
import { useMutation, useQuery } from "@tanstack/react-query";
import { addDays, format, parseISO, subDays } from "date-fns";
import { useState } from "react";
import { toast } from "sonner";

import { ledgerParty } from "../../finance/finance.functions";
import { meal as mealOperations } from "../meal.functions";
import type {
  MealPreparationsView,
  PreparationEaterOption,
  PreparationSaveRequest,
  PreparationTargetOption,
} from "./types";

export type PreparationSourceChoice = {
  value: string;
  mealId: MealShortcode;
  mealRecipeId: string;
  label: string;
  servings: number | null;
};

function sourceChoicesFor(
  meals: MealOut[] | undefined,
  beforeDate: string,
  currentMealId: MealShortcode,
): PreparationSourceChoice[] {
  return (
    meals
      ?.filter(
        (target) => target.date <= beforeDate && target.id !== currentMealId,
      )
      .flatMap((target) =>
        target.recipes.map((recipe, index) => {
          const duplicate =
            target.recipes.filter(
              (candidate) => candidate.recipeId === recipe.recipeId,
            ).length > 1;
          const ordinal = duplicate
            ? target.recipes.filter(
                (candidate, candidateIndex) =>
                  candidate.recipeId === recipe.recipeId &&
                  candidateIndex < index,
              ).length + 1
            : null;
          return {
            value: `${target.id}:${recipe.id}`,
            mealId: target.id,
            mealRecipeId: recipe.id,
            label: `${recipe.recipe.name}${ordinal ? ` · ${ordinal}` : ""} · ${target.name ?? target.date}`,
            servings: recipe.recipe.servings ?? null,
          };
        }),
      ) ?? []
  );
}

export function useMealPreparationController({
  mealId,
  mealDate,
  invalidate,
  onSaved,
}: {
  mealId: MealShortcode;
  mealDate: string | undefined;
  invalidate: () => void;
  onSaved?: () => void;
}) {
  const [openMealRecipeId, setOpenMealRecipeId] = useState<string | null>(null);
  const [sourcePickerOpen, setSourcePickerOpen] = useState(false);
  const [sourceSelectionId, setSourceSelectionId] = useState<string | null>(
    null,
  );
  const preparationQuery = useQuery(
    mealOperations.getPreparations.queryOptions({ mealId }),
  );
  const rangeAnchor = mealDate ?? "1970-01-01";
  const rangeStart = format(subDays(parseISO(rangeAnchor), 30), "yyyy-MM-dd");
  const rangeEnd = format(addDays(parseISO(rangeAnchor), 30), "yyyy-MM-dd");
  const targetMealsQuery = useQuery({
    ...mealOperations.getByDateRange.queryOptions({
      from: rangeStart,
      to: rangeEnd,
    }),
    enabled: mealDate != null && openMealRecipeId != null,
  });
  const sourceMealsQuery = useQuery({
    ...mealOperations.getByDateRange.queryOptions({
      from: rangeStart,
      to: rangeAnchor,
    }),
    enabled: mealDate != null && sourcePickerOpen,
  });
  const eatersQuery = useQuery({
    ...ledgerParty.options.queryOptions(null),
    enabled: openMealRecipeId != null,
  });
  const targetMeals: PreparationTargetOption[] =
    targetMealsQuery?.data
      ?.map((target) => ({
        id: target.id,
        date: target.date,
        name: target.name,
        mealKind: target.mealKind,
      }))
      .sort((left, right) =>
        left.id === mealId ? -1 : right.id === mealId ? 1 : 0,
      ) ?? [];
  const eaters: PreparationEaterOption[] =
    eatersQuery.data?.filter(
      (party): party is PreparationEaterOption =>
        party.kind === "member" || party.kind === "guest",
    ) ?? [];
  const sourceChoices = sourceChoicesFor(
    sourceMealsQuery?.data,
    mealDate ?? "",
    mealId,
  );
  const selectedSourceChoice = sourceChoices.find(
    (choice) => choice.value === sourceSelectionId,
  );
  const sourcePreparationQuery = useQuery({
    ...mealOperations.getPreparations.queryOptions({
      mealId: selectedSourceChoice?.mealId ?? mealId,
    }),
    enabled: selectedSourceChoice != null,
  });
  const selectedPreparationView = selectedSourceChoice
    ? sourcePreparationQuery.data
    : preparationQuery.data;
  const selectedPreparation = selectedPreparationView?.preparations.find(
    (preparation) => preparation.mealRecipeId === openMealRecipeId,
  );
  const savePreparationMutation = useMutation(
    mealOperations.savePreparation.mutationOptions({
      onSuccess: () => {
        setOpenMealRecipeId(null);
        setSourceSelectionId(null);
        void preparationQuery.refetch();
        void sourcePreparationQuery.refetch();
        invalidate();
        toast.success("Portions saved");
        onSaved?.();
      },
    }),
  );

  return {
    view: preparationQuery.data,
    targetMeals,
    eaters,
    sourceChoices,
    selectedSourceChoice,
    selectedPreparation,
    sourcePickerOpen,
    isLoadingSourceChoices: sourceMealsQuery.isLoading,
    openMealRecipeId,
    isSaving: savePreparationMutation.isPending,
    setSourcePickerOpen,
    setSourceSelectionId,
    openCurrentPreparation: (id: string) => {
      setSourceSelectionId(null);
      setOpenMealRecipeId(id);
    },
    beginAddPreparedPortion: () => setSourcePickerOpen(true),
    chooseSource: () => {
      if (!selectedSourceChoice) return;
      setSourcePickerOpen(false);
      setOpenMealRecipeId(selectedSourceChoice.mealRecipeId);
    },
    closePreparation: () => {
      setOpenMealRecipeId(null);
      setSourceSelectionId(null);
    },
    save: (request: PreparationSaveRequest) =>
      savePreparationMutation.mutate(request),
    refetchPreparations: () => preparationQuery.refetch(),
  } satisfies {
    view: MealPreparationsView | undefined;
    targetMeals: PreparationTargetOption[];
    eaters: PreparationEaterOption[];
    sourceChoices: PreparationSourceChoice[];
    selectedSourceChoice: PreparationSourceChoice | undefined;
    selectedPreparation:
      | MealPreparationsView["preparations"][number]
      | undefined;
    sourcePickerOpen: boolean;
    isLoadingSourceChoices: boolean;
    openMealRecipeId: string | null;
    isSaving: boolean;
    setSourcePickerOpen: typeof setSourcePickerOpen;
    setSourceSelectionId: typeof setSourceSelectionId;
    openCurrentPreparation: (id: string) => void;
    beginAddPreparedPortion: () => void;
    chooseSource: () => void;
    closePreparation: () => void;
    save: (request: PreparationSaveRequest) => void;
    refetchPreparations: typeof preparationQuery.refetch;
  };
}
