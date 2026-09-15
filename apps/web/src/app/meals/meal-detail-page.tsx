import type {
  MealShortcode,
  RecipeShortcode,
} from "@cubby/schemas/identifiers";
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
import {
  ChartNoAxesColumnIncreasing,
  ClipboardList,
  ImageIcon,
  Plus,
  Settings2,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { StaticPicker } from "~/app/_components/combobox/static-picker";
import { DetailSections } from "~/app/_components/data-table/detail-page";
import { DatePickerInput } from "~/app/_components/date-picker-input";
import { useUpdateMutation } from "~/app/_components/hooks/useUpdateMutation";
import { EntityPhotosSection } from "~/app/_components/photos/entity-photos-section";
import { SimpleLoading } from "~/components/feedback/loading-skeletons";
import { Row, Stack } from "~/components/layout";
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
import { useHouseholdToday } from "~/hooks/use-household-today";
import { getErrorMessage } from "~/lib/error-utils";

import { EditableCell } from "../_components/data-table/editable-cell";
import { AddFoodDialog } from "./add-food-dialog";
import { formatCostEstimate } from "./meal-nutrition";
import { MealNutritionSummary } from "./meal-nutrition-summary";
import {
  mealKindBadgeVariant,
  mealKindOptions,
  mealTypeOptions,
} from "./meal-options";
import { MealPortionsSection } from "./meal-preparation/meal-portions-section";
import { PortionSheet } from "./meal-preparation/portion-sheet";
import { RecipeFoodDialog } from "./meal-preparation/recipe-food-dialog";
import { useMealPreparationController } from "./meal-preparation/use-meal-preparation-controller";
import { meal as mealOperations } from "./meal.functions";
import { useInvalidateMeals } from "./use-meal-mutations";

type MealDetail = EntityDetailByEntity["meal"];

export function mealDisplayName(meal: {
  name: string | null;
  date: string;
}): string {
  return meal.name ? meal.name : format(parseISO(meal.date), "EEE, MMM d");
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
  const invalidate = useInvalidateMeals();
  const mealKey = entityDetailFor("meal").queryKey(mealId);
  const [addFoodOpen, setAddFoodOpen] = useState(false);
  const [recipeFoodId, setRecipeFoodId] = useState<RecipeShortcode | null>(
    null,
  );
  const householdToday = useHouseholdToday();
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

  return (
    <Page
      variant="detail"
      entity="meal"
      title={mealName}
      rawData={meal}
      heroImages={meal.images}
      heroStamp={{
        label: `${format(parseISO(meal.date), "EEE, MMM d")}${householdToday && meal.date > householdToday ? " · Planned" : ""}`,
        tone: "ink",
      }}
    >
      <DetailSections
        rawData={meal}
        heroImages={meal.images}
        sections={[
          {
            id: "nutrition-summary",
            title: "Nutrition by person",
            icon: ChartNoAxesColumnIncreasing,
            placement: "full",
            surface: "plain",
            content: (
              <Stack gap="md">
                <Row align="center" justify="between" gap="sm" wrap>
                  <h2 className="text-lg font-semibold tracking-tight">
                    Nutrition by person
                  </h2>
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => setAddFoodOpen(true)}
                  >
                    <Plus className="size-4" />
                    Add food
                  </Button>
                </Row>
                <MealNutritionSummary
                  mealId={mealId}
                  onEditRecipe={(mealRecipeId) =>
                    preparation.openCurrentPreparation(mealRecipeId)
                  }
                />
              </Stack>
            ),
          },
          {
            id: "meal-plan",
            title: "Recipes",
            icon: ClipboardList,
            placement: "primary",
            content: (
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
                        effectivePreparationView
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
            ),
          },
          {
            id: "meal-details",
            title: "Meal details",
            icon: Settings2,
            placement: "supporting",
            content: (
              <Stack gap="md">
                <Stack gap="sm">
                  <Description as="span" size="xs">
                    Name and date
                  </Description>
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
                </Stack>
                <Stack gap="sm">
                  <Description as="span" size="xs">
                    Meal type
                  </Description>
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
                </Stack>
              </Stack>
            ),
          },
          {
            id: "photos",
            title: "Photos",
            icon: ImageIcon,
            placement: "supporting",
            content: meal.images.length ? (
              <EntityPhotosSection
                entity="meal"
                id={meal.id}
                images={meal.images}
              />
            ) : (
              <details className="text-sm">
                <summary className="min-h-10 cursor-pointer content-center text-muted-foreground hover:text-foreground">
                  No photos · Add one
                </summary>
                <div className="border-t pt-2">
                  <EntityPhotosSection
                    entity="meal"
                    id={meal.id}
                    images={meal.images}
                  />
                </div>
              </details>
            ),
          },
          ...(effectivePreparationView
            ? [
                {
                  id: "meal-portions",
                  title: "Recipe preparation",
                  icon: ClipboardList,
                  placement: "full" as const,
                  surface: "plain" as const,
                  content: (
                    <MealPortionsSection
                      view={effectivePreparationView}
                      onAddPreparedPortion={preparation.beginAddPreparedPortion}
                      onEditPreparation={preparation.openCurrentPreparation}
                    />
                  ),
                },
              ]
            : []),
        ]}
      />
      <MealPreparationOverlays
        preparation={preparation}
        recipes={meal.recipes}
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
    </Page>
  );
}

function MealPreparationOverlays({
  preparation,
  recipes,
  currentMealId,
}: {
  preparation: ReturnType<typeof useMealPreparationController>;
  recipes: MealRecipeOut[];
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
          recipeServings={
            recipes.find(
              (recipe) =>
                recipe.id === preparation.selectedPreparation?.mealRecipeId,
            )?.recipe.servings ?? preparation.selectedSourceChoice?.servings
          }
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
              <Trash2 className="size-4" />
              Remove
            </Button>
          </Row>
        </Row>
      </details>
    </div>
  );
}
