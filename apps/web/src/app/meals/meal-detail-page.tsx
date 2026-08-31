import type { MealShortcode } from "@cubby/schemas/identifiers";
import type { MealRecipeOut } from "@cubby/schemas/meal";
import {
  MEAL_KIND_LABELS,
  MEAL_TYPE_LABELS,
  mealKindSchema,
  mealTypeSchema,
} from "@cubby/schemas/meal-classification";
import type { QueryKey } from "@tanstack/react-query";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { format, parseISO } from "date-fns";
import { ClipboardList, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { EntityPicker } from "~/app/_components/combobox/entity-picker";
import { StaticPicker } from "~/app/_components/combobox/static-picker";
import { WithRecipeSearch } from "~/app/_components/combobox/with-search-hook";
import { DetailSections } from "~/app/_components/data-table/detail-page";
import { DatePickerInput } from "~/app/_components/date-picker-input";
import { useUpdateMutation } from "~/app/_components/hooks/useUpdateMutation";
import { SimpleLoading } from "~/components/feedback/loading-skeletons";
import { Row, Stack } from "~/components/layout";
import type { DetailHeroStat } from "~/components/layouts/page-hero";
import { Page } from "~/components/page/Page";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Description } from "~/components/ui/description";
import { DialogFooter } from "~/components/ui/dialog";
import { Empty, EmptyDescription, EmptyTitle } from "~/components/ui/empty";
import { EntityFilterLink } from "~/components/ui/entity-filter-link";
import { Input } from "~/components/ui/input";
import { NoneValue } from "~/components/ui/none-value";
import { ResponsiveDialog } from "~/components/ui/responsive-dialog";
import { entityDetailLink } from "~/entities/entities";
import { entityMutationOptionsFactory } from "~/entities/entity-contracts";
import { entityDetailFor } from "~/entities/entity-detail.functions";
import type { EntityDetailByEntity } from "~/entities/generated/entity-details.gen";
import { getErrorMessage } from "~/lib/error-utils";
import { formatCurrency } from "~/lib/utils";

import { EditableCell } from "../_components/data-table/editable-cell";
import {
  mealKindBadgeVariant,
  mealKindOptions,
  mealTypeOptions,
} from "./meal-options";
import { MealPortionsSection } from "./meal-preparation/meal-portions-section";
import { PortionSheet } from "./meal-preparation/portion-sheet";
import type { MealPreparationsView } from "./meal-preparation/types";
import { calorieText } from "./meal-preparation/types";
import { useMealPreparationController } from "./meal-preparation/use-meal-preparation-controller";
import { meal as mealOperations } from "./meal.functions";
import { useInvalidateMeals } from "./use-meal-mutations";

type MealDetail = EntityDetailByEntity["meal"];

function mealDisplayName(meal: MealDetail): string {
  return meal.name ? meal.name : format(parseISO(meal.date), "EEE, MMM d");
}

function buildMealHeroStats(
  meal: MealDetail,
  preparation: MealPreparationsView | undefined,
): DetailHeroStat[] {
  const calorieStat =
    preparation && preparation.totals.confirmed.portionCount > 0
      ? {
          label: "Consumed calories",
          value: calorieText(preparation.totals.confirmed.calories),
        }
      : { label: "Calories", value: Math.round(meal.totals.caloriesTotal) };

  return [
    {
      label: "Cost",
      value:
        meal.totals.pending && meal.totals.costTotal === 0
          ? "—"
          : `${formatCurrency(meal.totals.costTotal)}${meal.totals.pending ? "+" : ""}`,
    },
    calorieStat,
    { label: "Recipes", value: meal.recipes.length },
  ];
}

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

export function MealDetailPage({ mealId }: { mealId: MealShortcode }) {
  const queryClient = useQueryClient();
  const invalidate = useInvalidateMeals();
  const mealKey = entityDetailFor("meal").queryKey(mealId);
  const [pendingRecipeName, setPendingRecipeName] = useState<string | null>(
    null,
  );
  const {
    data: meal,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery(entityDetailFor("meal").queryOptions(mealId));
  const preparation = useMealPreparationController({
    mealId,
    mealDate: meal?.date,
    invalidate,
  });
  const effectivePreparationView = preparation.view;

  const updateMeal = useUpdateMutation({
    mutationFn: entityMutationOptionsFactory("meal", "update"),
    entity: "meal",
  });
  const addRecipeBase = mealOperations.addRecipe.mutationOptions();
  const addRecipe = useMutation({
    ...addRecipeBase,
    onMutate: async (variables) => {
      await queryClient.cancelQueries({ queryKey: mealKey });
      const previous = queryClient.getQueryData<MealDetail | null>(mealKey);
      setPendingRecipeName(variables.recipeId);
      return { previous };
    },
    onSuccess: (updated) => {
      queryClient.setQueryData(mealKey, updated);
    },
    onError: (error, _variables, context) => {
      if (context?.previous)
        queryClient.setQueryData(mealKey, context.previous);
      toast.error(getErrorMessage(error));
    },
    onSettled: () => {
      setPendingRecipeName(null);
      invalidate();
    },
  });

  const mealName = meal ? mealDisplayName(meal) : "";

  const [name, setName] = useState<string | null>(null);

  if (isLoading) {
    return (
      <Page variant="list" title="Meal" entity="meal">
        <SimpleLoading text="Loading meal..." />
      </Page>
    );
  }

  // Distinguish a transient fetch failure from a genuine 404 so a dropped
  // connection doesn't masquerade as "Meal not found".
  if (isError) {
    return (
      <Page variant="list" title="Meal" entity="meal">
        <Empty>
          <EmptyTitle>Couldn't load this meal</EmptyTitle>
          <EmptyDescription>
            {error.message || "Something went wrong."}
          </EmptyDescription>
          <Button type="button" variant="outline" onClick={() => refetch()}>
            Retry
          </Button>
        </Empty>
      </Page>
    );
  }

  if (!meal) {
    return (
      <Page variant="list" title="Meal not found" entity="meal" compact>
        <Empty>
          <EmptyTitle>Meal not found</EmptyTitle>
          <EmptyDescription>
            This meal is no longer available.{" "}
            <Link to="/meals" className="underline">
              Back to meals
            </Link>
          </EmptyDescription>
        </Empty>
      </Page>
    );
  }

  const nameValue = name ?? meal.name ?? "";

  const heroStats = buildMealHeroStats(meal, effectivePreparationView);

  return (
    <Page
      variant="detail"
      entity="meal"
      title={mealName}
      rawData={meal}
      heroStats={heroStats}
      heroStamp={{
        label: format(parseISO(meal.date), "EEE, MMM d"),
        tone: "ink",
      }}
    >
      <DetailSections
        rawData={meal}
        sections={[
          {
            id: "meal-plan",
            title: "Meal plan",
            icon: ClipboardList,
            placement: "full",
            surface: "plain",
            content: (
              <Stack>
                <Row align="end" wrap gap="md">
                  <Stack gap="sm" className="w-full md:w-auto">
                    <Input
                      value={nameValue}
                      placeholder="Meal name (optional)"
                      className="h-11 w-full font-medium md:h-9 md:w-64"
                      onChange={(e) => setName(e.target.value)}
                      onBlur={() => {
                        const next = nameValue.trim() || null;
                        if (next !== (meal.name ?? null)) {
                          updateMeal.mutate({
                            id: mealId,
                            data: { name: next },
                          });
                        }
                      }}
                    />
                    <DatePickerInput
                      value={meal.date}
                      aria-label="Meal date"
                      className="w-44"
                      required
                      onChange={(value) => {
                        if (!value) return;
                        updateMeal.mutate({
                          id: mealId,
                          data: { date: value },
                        });
                      }}
                    />
                  </Stack>
                  <Stack gap="sm">
                    <Row align="center" gap="tight">
                      <EditableCell
                        value={meal.mealType}
                        config={{ type: "select", options: mealTypeOptions }}
                        onSave={async (mealType) => {
                          // Nullable on purpose — clearing it means "unslotted", which
                          // is a real state, not a rejected edit.
                          const parsedMealType =
                            mealType === null
                              ? null
                              : mealTypeSchema.parse(mealType);
                          await updateMeal.mutateAsync({
                            id: mealId,
                            data: {
                              mealType: parsedMealType,
                            },
                          });
                        }}
                        renderValue={(value) => {
                          const parsedMealType = mealTypeSchema
                            .nullable()
                            .safeParse(value).data;
                          return parsedMealType ? (
                            <Badge variant="outline">
                              {MEAL_TYPE_LABELS[parsedMealType]}
                            </Badge>
                          ) : (
                            <NoneValue />
                          );
                        }}
                      />
                      {meal.mealType ? (
                        <EntityFilterLink
                          to="/meals"
                          search={{ view: "table", mealType: meal.mealType }}
                          label={`Show all ${MEAL_TYPE_LABELS[meal.mealType]} meals`}
                        />
                      ) : null}
                    </Row>
                    <Row align="center" gap="tight">
                      <EditableCell
                        value={meal.mealKind}
                        config={{ type: "select", options: mealKindOptions }}
                        onSave={async (mealKind) => {
                          // NOT NULL — a cleared select is a no-op, not a null write.
                          if (!mealKind) return;
                          const parsedMealKind = mealKindSchema.parse(mealKind);
                          await updateMeal.mutateAsync({
                            id: mealId,
                            data: { mealKind: parsedMealKind },
                          });
                        }}
                        renderValue={(value) => {
                          const parsedMealKind =
                            mealKindSchema.safeParse(value).data;
                          return parsedMealKind ? (
                            <Badge
                              variant={mealKindBadgeVariant[parsedMealKind]}
                            >
                              {MEAL_KIND_LABELS[parsedMealKind]}
                            </Badge>
                          ) : (
                            <NoneValue />
                          );
                        }}
                      />
                      <EntityFilterLink
                        to="/meals"
                        search={{ view: "table", mealKind: meal.mealKind }}
                        label={`Show all ${MEAL_KIND_LABELS[meal.mealKind]} meals`}
                      />
                    </Row>
                  </Stack>
                </Row>

                <Stack gap="sm">
                  {meal.recipes.length === 0 ? (
                    // A meal you aren't cooking is COMPLETE with no recipes — telling
                    // someone to add one would be wrong, and it's also why this meal
                    // contributes nothing to the shopping list.
                    <Description>
                      {meal.mealKind === "cooked"
                        ? "No recipes yet — add one below."
                        : meal.mealKind === "leftovers"
                          ? "Leftovers only — add a prepared portion from an earlier meal."
                          : `${MEAL_KIND_LABELS[meal.mealKind]} — no recipes needed.`}
                    </Description>
                  ) : (
                    meal.recipes.map((mr, index) => (
                      <RecipeRow
                        key={mr.id}
                        mr={mr}
                        ordinal={recipeOrdinal(
                          meal.recipes,
                          mr.recipeId,
                          index,
                        )}
                        onOpenPreparation={
                          effectivePreparationView
                            ? (mealRecipeId) => {
                                preparation.openCurrentPreparation(
                                  mealRecipeId,
                                );
                              }
                            : undefined
                        }
                        mealKey={mealKey}
                        onChanged={invalidate}
                      />
                    ))
                  )}
                  {pendingRecipeName && (
                    <Row
                      align="center"
                      gap="sm"
                      className="border border-[var(--border)] p-2 opacity-60"
                    >
                      <span className="flex-1 truncate text-sm font-medium">
                        Adding recipe…
                      </span>
                    </Row>
                  )}
                </Stack>

                <div className="max-w-sm">
                  <Description as="span" size="xs" className="mb-1 block">
                    Add a recipe
                  </Description>
                  <WithRecipeSearch>
                    {({ items, onSearchChange, isLoading, onOpenChange }) => (
                      <EntityPicker
                        entity="recipe"
                        label="recipe"
                        items={items}
                        value={null}
                        placeholder="Search recipes…"
                        disabled={addRecipe.isPending}
                        onSearchChange={onSearchChange}
                        onOpenChange={onOpenChange}
                        isLoading={isLoading}
                        setValue={(recipe) => {
                          if (!recipe) return;
                          addRecipe.mutate({
                            mealId,
                            recipeId: recipe.id,
                            scale: 1,
                          });
                        }}
                      />
                    )}
                  </WithRecipeSearch>
                </div>
              </Stack>
            ),
          },
          ...(effectivePreparationView
            ? [
                {
                  id: "meal-portions",
                  title: "Portions",
                  icon: ClipboardList,
                  placement: "full" as const,
                  surface: "plain" as const,
                  content: (
                    <MealPortionsSection
                      view={effectivePreparationView}
                      onAddPreparedPortion={preparation.beginAddPreparedPortion}
                    />
                  ),
                },
              ]
            : []),
        ]}
      />
      <MealPreparationOverlays preparation={preparation} />
    </Page>
  );
}

function MealPreparationOverlays({
  preparation,
}: {
  preparation: ReturnType<typeof useMealPreparationController>;
}) {
  return (
    <>
      <ResponsiveDialog
        open={preparation.sourcePickerOpen}
        onOpenChange={preparation.setSourcePickerOpen}
        title="Add a prepared portion"
        description="Choose a recipe occurrence from an earlier meal. Its measured yield and live recipe calories stay with that source."
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
        {preparation.sourceChoices.length ? (
          <StaticPicker
            items={preparation.sourceChoices.map(({ value, label }) => ({
              value,
              label,
            }))}
            value={preparation.selectedSourceChoice?.value ?? null}
            onValueChange={preparation.setSourceSelectionId}
            label="Prepared recipe"
            placeholder="Choose an earlier recipe"
          />
        ) : (
          <Description>
            No earlier recipe occurrences are available in the recent meal
            window.
          </Description>
        )}
      </ResponsiveDialog>
      {preparation.selectedPreparation ? (
        <PortionSheet
          source={preparation.selectedPreparation}
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
      toast.error(getErrorMessage(error));
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
      toast.error(getErrorMessage(error));
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
    <Row align="center" gap="sm" className="border border-[var(--border)] p-2">
      <Link
        {...entityDetailLink("recipe", mr.recipe.id)}
        className="flex-1 truncate text-sm font-medium hover:underline"
        title={mr.recipe.name}
      >
        {mr.recipe.name}
        {ordinal ? ` · ${ordinal}` : null}
      </Link>
      <Row align="center" gap="xs">
        <Input
          type="number"
          step={0.5}
          min={0.5}
          value={scale}
          className="h-7 w-16 text-right tabular-nums"
          onChange={(e) => setScale(e.target.value)}
          onBlur={commitScale}
          aria-label="Scale"
        />
        <span className="text-xs text-muted-foreground">×</span>
      </Row>
      <span className="w-16 text-right text-sm tabular-nums">
        {mr.scaledTotals ? formatCurrency(mr.scaledTotals.costTotal) : "—"}
      </span>
      {onOpenPreparation ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onOpenPreparation(mr.id)}
        >
          Portions
        </Button>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label="Remove recipe"
        disabled={removeRecipe.isPending}
        onClick={() => removeRecipe.mutate({ id: mr.id })}
      >
        <Trash2 className="size-4" />
      </Button>
    </Row>
  );
}
