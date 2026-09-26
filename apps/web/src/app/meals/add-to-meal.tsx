import type { RecipeShortcode } from "@cubby/schemas/identifiers";
import type { MealOut } from "@cubby/schemas/meal";
import {
  MEAL_KIND_LABELS,
  type MealKind,
  type MealType,
  mealKindSchema,
  mealTypeSchema,
} from "@cubby/schemas/meal-classification";
import { CalendarPlusIcon } from "@phosphor-icons/react/dist/csr/CalendarPlus";
import { WarningIcon } from "@phosphor-icons/react/dist/csr/Warning";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { format, parseISO } from "date-fns";
import { useId, useMemo, useState } from "react";
import { toast } from "sonner";

import { useEntitySuggestionsQuery } from "~/app/_components/ai/field-suggestion";
import { FieldSuggestionHint } from "~/app/_components/ai/field-suggestion-hint";
import { SuggestionVisitProvider } from "~/app/_components/ai/suggestion-review";
import { StaticPicker } from "~/app/_components/combobox/static-picker";
import { DatePickerInput } from "~/app/_components/date-picker-input";
import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { DialogFormActions } from "~/components/ui/dialog-form-actions";
import { Label } from "~/components/ui/label";
import { ResponsiveDialog } from "~/components/ui/responsive-dialog";
import { entities, entityDetailParams } from "~/entities/entities";
import { entityMutation } from "~/entities/entity-mutation.functions";
import { fieldEnumOptions } from "~/entities/enum-field-display";
import { ai } from "~/lib/ai.functions";
import type { EntityBrowserMutationResult } from "~/server/entity-kernel/contracts";

import { mealListLabel } from "./meal-format";
import { meal } from "./meal.functions";
import { useInvalidateMeals } from "./use-meal-mutations";

const NEW_MEAL = "new";

/** The remote operations this dialog coordinates. Keeping them together lets a
 * browser test run the production query/mutation stack with parsed in-memory
 * transports, rather than replacing React Query or a module at its boundary. */
export interface AddToMealOperations {
  suggestFields: typeof ai.suggestFields;
  existingMeals: typeof meal.getByDateRange;
  addRecipe: typeof meal.addRecipe;
  mealMutation: typeof entityMutation.mutate;
}

const productionOperations: AddToMealOperations = {
  suggestFields: ai.suggestFields,
  existingMeals: meal.getByDateRange,
  addRecipe: meal.addRecipe,
  mealMutation: entityMutation.mutate,
};

const today = () => format(new Date(), "yyyy-MM-dd");

/**
 * The slot a recipe added right now most likely belongs to. A suggestion in a
 * visible field, never a silent write — the picker still shows it and the user
 * can change it before submitting.
 *
 * Deliberately NOT derived from `MEAL_TYPE_START_MINUTES` by taking the latest
 * slot already started. That map says when a slot is eaten; these bounds say
 * what you are most likely *planning* at a given hour, and the two disagree
 * where it matters — at 4pm you are almost always adding a recipe to tonight's
 * dinner, not to a snack that nominally began at 3.
 */
const slotForNow = (): MealType => {
  const hour = new Date().getHours();
  if (hour < 10) return "breakfast";
  if (hour < 12) return "brunch";
  if (hour < 15) return "lunch";
  if (hour < 21) return "dinner";
  return "snack";
};

/**
 * Plans the current recipe onto a day, either by extending one of that day's
 * existing meals or by creating a new one. Lives on recipe detail pages.
 */
function createdMeal(result: EntityBrowserMutationResult): MealOut | undefined {
  return result.action === "create" && result.entity === "meal"
    ? result.item
    : undefined;
}

function mealTypeFromPicker(value: string | null): MealType | null {
  const result = mealTypeSchema.safeParse(value);
  return result.success ? result.data : null;
}

function mealKindFromPicker(value: string | null): MealKind {
  const result = mealKindSchema.safeParse(value);
  return result.success ? result.data : "cooked";
}

export function AddToMeal({
  recipeId,
  recipeName,
  operations = productionOperations,
}: {
  recipeId: RecipeShortcode;
  recipeName: string;
  operations?: AddToMealOperations;
}) {
  const navigate = useNavigate();
  const invalidate = useInvalidateMeals();
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(today);
  const [target, setTarget] = useState(NEW_MEAL);
  const [mealType, setMealType] = useState<MealType | null>(slotForNow);
  const [mealKind, setMealKind] = useState<MealKind>("cooked");
  const [switchToCooked, setSwitchToCooked] = useState(true);
  const dateInputId = useId();
  const switchId = useId();

  const existingMeals = useQuery({
    ...operations.existingMeals.queryOptions({ from: date, to: date }),
    enabled: open,
  });

  const suggestionSource = {
    entity: "meal" as const,
    basisMode: "provided" as const,
    targets: ["mealType", "mealKind"],
    basis: { name: recipeName },
  };
  const {
    suggestions,
    outcomes: suggestionOutcomes,
    isFetching: checkingSuggestions,
  } = useEntitySuggestionsQuery({
    source: suggestionSource,
    enabled: open && target === NEW_MEAL,
    operations,
  });

  const mealOptions = useMemo(
    () => [
      { value: NEW_MEAL, label: "Create a new meal" },
      ...(existingMeals.data?.map((meal) => ({
        value: meal.id,
        // The kind rides the label for non-cooked meals so the consequence is
        // visible before selecting, not only after.
        label:
          meal.mealKind === "cooked"
            ? `${mealListLabel(meal)} (${meal.recipes.length} recipe${
                meal.recipes.length === 1 ? "" : "s"
              })`
            : `${mealListLabel(meal)} — ${MEAL_KIND_LABELS[meal.mealKind]}`,
      })) ?? []),
    ],
    [existingMeals.data],
  );

  const selectedMeal: MealOut | undefined =
    target === NEW_MEAL
      ? undefined
      : existingMeals.data?.find((meal) => meal.id === target);
  // Planning a recipe into a meal you aren't cooking is contradictory, and it
  // loses the ingredients silently: only `cooked` meals feed the shopping list.
  const targetNotCooked =
    selectedMeal != null && selectedMeal.mealKind !== "cooked";

  const onSuccess = (meal: { id: string; date: string }) => {
    invalidate();
    setOpen(false);
    toast.success(
      `Added to a meal on ${format(parseISO(meal.date), "EEE, MMM d")}`,
      {
        action: {
          label: "View",
          onClick: () =>
            void navigate({
              to: entities.meal.routes.detail,
              params: entityDetailParams(meal.id),
            }),
        },
      },
    );
  };

  const createMeal = useMutation(
    operations.mealMutation.forEntity("meal").mutationOptions({
      onSuccess: (result) => {
        const meal = createdMeal(result);
        if (meal) onSuccess(meal);
      },
    }),
  );
  const addRecipe = useMutation(
    operations.addRecipe.mutationOptions({ onSuccess }),
  );
  const updateMeal = useMutation(
    operations.mealMutation.forEntity("meal").mutationOptions(),
  );
  const isPending =
    createMeal.isPending || addRecipe.isPending || updateMeal.isPending;

  const submit = async () => {
    if (target === NEW_MEAL) {
      createMeal.mutate({
        action: "create",
        entity: "meal",
        data: {
          date,
          mealType,
          mealKind,
          recipes: [{ recipeId, scale: 1 }],
        },
      });
      return;
    }
    // Re-kind first so the meal is never briefly a non-cooked meal holding a
    // recipe — that intermediate state is the one the shopping list drops.
    if (targetNotCooked && switchToCooked) {
      await updateMeal.mutateAsync({
        action: "update",
        entity: "meal",
        id: target,
        data: { mealKind: "cooked" },
      });
    }
    addRecipe.mutate({ mealId: target, recipeId, scale: 1 });
  };

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
      >
        <CalendarPlusIcon className="size-4" />
        Add to meal
      </Button>
      <ResponsiveDialog
        open={open}
        onOpenChange={setOpen}
        size="md"
        title="Add to meal"
        description="Choose a day and an existing meal, or create a separate meal for this recipe."
        footer={
          <DialogFormActions
            onCancel={() => setOpen(false)}
            submitLabel={
              target === NEW_MEAL ? "Create meal" : "Add to selected meal"
            }
            pending={isPending}
            submitDisabled={existingMeals.isLoading}
            onSubmit={() => void submit()}
          />
        }
      >
        <Stack gap="sm">
          <Stack gap="xs">
            <Label htmlFor={dateInputId}>Day</Label>
            <DatePickerInput
              id={dateInputId}
              value={date}
              required
              onChange={(value) => {
                if (!value) return;
                setDate(value);
                setTarget(NEW_MEAL);
              }}
            />
          </Stack>
          <Stack gap="xs">
            <Label>Meal</Label>
            <StaticPicker
              items={mealOptions}
              value={target}
              disabled={existingMeals.isLoading}
              onValueChange={(value) => setTarget(value ?? NEW_MEAL)}
              label="meal"
            />
          </Stack>

          {target === NEW_MEAL && (
            <SuggestionVisitProvider>
              <Row gap="sm" wrap>
                <Stack gap="xs" className="min-w-40 flex-1">
                  <Label>Meal type</Label>
                  <StaticPicker
                    items={fieldEnumOptions("meal", "mealType")}
                    value={mealType}
                    onValueChange={(value) =>
                      setMealType(mealTypeFromPicker(value))
                    }
                    label="meal type"
                    clearable
                  />
                  <FieldSuggestionHint
                    suggestion={suggestions.mealType ?? null}
                    applied={false}
                    currentValue={mealType}
                    currentLabel={
                      fieldEnumOptions("meal", "mealType").find(
                        (option) => option.value === mealType,
                      )?.label
                    }
                    questionKey={JSON.stringify([suggestionSource, "mealType"])}
                    pending={checkingSuggestions}
                    onApply={() =>
                      setMealType(
                        mealTypeFromPicker(suggestions.mealType?.value ?? null),
                      )
                    }
                    outcome={suggestionOutcomes.mealType ?? null}
                  />
                </Stack>
                <Stack gap="xs" className="min-w-40 flex-1">
                  <Label>Kind</Label>
                  <StaticPicker
                    items={fieldEnumOptions("meal", "mealKind")}
                    value={mealKind}
                    onValueChange={(value) =>
                      setMealKind(mealKindFromPicker(value))
                    }
                    label="kind"
                  />
                  <FieldSuggestionHint
                    suggestion={suggestions.mealKind ?? null}
                    applied={false}
                    currentValue={mealKind}
                    currentLabel={MEAL_KIND_LABELS[mealKind]}
                    questionKey={JSON.stringify([suggestionSource, "mealKind"])}
                    pending={checkingSuggestions}
                    onApply={() =>
                      setMealKind(
                        mealKindFromPicker(suggestions.mealKind?.value ?? null),
                      )
                    }
                    outcome={suggestionOutcomes.mealKind ?? null}
                  />
                </Stack>
              </Row>
            </SuggestionVisitProvider>
          )}

          {targetNotCooked && selectedMeal && (
            <Stack
              gap="snug"
              className="border border-warning/40 bg-warning/5 px-2 py-2 text-2xs"
            >
              <Row gap="xs" align="center" className="text-warning-ink">
                <WarningIcon className="size-3 shrink-0" />
                <span className="font-medium">
                  This is a{" "}
                  {MEAL_KIND_LABELS[selectedMeal.mealKind].toLowerCase()} meal,
                  so its recipes aren't added to the shopping list.
                </span>
              </Row>
              <Row gap="xs" align="center" className="text-muted-foreground">
                <Checkbox
                  id={switchId}
                  checked={switchToCooked}
                  onCheckedChange={(checked) =>
                    setSwitchToCooked(checked === true)
                  }
                />
                <Label htmlFor={switchId} className="text-2xs font-normal">
                  Switch it to Cooked when adding
                </Label>
              </Row>
            </Stack>
          )}
        </Stack>
      </ResponsiveDialog>
    </>
  );
}
