import type { MealShortcode } from "@cubby/schemas/identifiers";
import type { MealOut } from "@cubby/schemas/meal";
import { useMutation, useQuery } from "@tanstack/react-query";
import { addDays, format, parseISO, subDays } from "date-fns";
import { useState } from "react";
import { toast } from "sonner";

import { getErrorMessage } from "~/lib/error-utils";

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
};

function sourceChoicesFor(
  meals: MealOut[] | undefined,
  beforeDate: string,
): PreparationSourceChoice[] {
  return (
    meals
      ?.filter((target) => target.date < beforeDate)
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
          };
        }),
      ) ?? []
  );
}

export function useMealPreparationController({
  mealId,
  mealDate,
  invalidate,
}: {
  mealId: MealShortcode;
  mealDate: string | undefined;
  invalidate: () => void;
}) {
  const [openMealRecipeId, setOpenMealRecipeId] = useState<string | null>(null);
  const [sourcePickerOpen, setSourcePickerOpen] = useState(false);
  const [sourceSelectionId, setSourceSelectionId] = useState<string | null>(
    null,
  );
  const preparationQuery = useQuery(
    mealOperations.getPreparations.queryOptions({ mealId }),
  );
  const preparationDate = mealDate ?? format(new Date(), "yyyy-MM-dd");
  const targetMealsQuery = useQuery({
    ...mealOperations.getByDateRange.queryOptions({
      from: format(subDays(parseISO(preparationDate), 30), "yyyy-MM-dd"),
      to: format(addDays(parseISO(preparationDate), 30), "yyyy-MM-dd"),
    }),
    enabled: preparationQuery.data != null,
  });
  const sourceMealsQuery = useQuery({
    ...mealOperations.getByDateRange.queryOptions({
      from: format(subDays(parseISO(preparationDate), 30), "yyyy-MM-dd"),
      to: preparationDate,
    }),
    enabled: preparationQuery.data != null,
  });
  const eatersQuery = useQuery({
    ...ledgerParty.options.queryOptions(null),
    enabled: preparationQuery.data != null,
  });
  const targetMeals: PreparationTargetOption[] =
    targetMealsQuery.data
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
    sourceMealsQuery.data,
    preparationDate,
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
      },
      onError: (error) => toast.error(getErrorMessage(error)),
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
    openMealRecipeId: string | null;
    isSaving: boolean;
    setSourcePickerOpen: typeof setSourcePickerOpen;
    setSourceSelectionId: typeof setSourceSelectionId;
    openCurrentPreparation: (id: string) => void;
    beginAddPreparedPortion: () => void;
    chooseSource: () => void;
    closePreparation: () => void;
    save: (request: PreparationSaveRequest) => void;
  };
}
