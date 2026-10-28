import { fieldValueOf } from "@cubby/schemas/field-envelope";
import type { RecipeShortcode } from "@cubby/schemas/identifiers";
import { mealOut } from "@cubby/schemas/meal";
import {
  MEAL_KIND_LABELS,
  type MealKind,
  type MealType,
  mealKindSchema,
  mealTypeSchema,
} from "@cubby/schemas/meal-classification";
import { countLabel } from "@cubby/shared/pluralize";
import { CalendarPlusIcon } from "@phosphor-icons/react/dist/csr/CalendarPlus";
import { WarningIcon } from "@phosphor-icons/react/dist/csr/Warning";
import { useQueryClient } from "@tanstack/react-query";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { format } from "date-fns";
import { useId, useMemo, useState } from "react";
import { toast } from "sonner";

import { renderSuggestedListFieldValue } from "~/entity/display/entity-display";
import { fieldEnumOptions } from "~/entity/display/enum-field-display";
import type { ListRowOf } from "~/entity/display/list-renderer-types";
import { entities, entityDetailParams } from "~/entity/entities";
import { useEntityMetadata } from "~/entity/metadata";
import { buildRecordComboboxItem } from "~/entity/picker/combobox-builders";
import { Picker } from "~/entity/picker/picker";
import { useEntitySuggestionsQuery } from "~/entity/suggestions/field-suggestion";
import { FieldSuggestionHint } from "~/entity/suggestions/field-suggestion-hint";
import { SuggestionVisitProvider } from "~/entity/suggestions/suggestion-review";
import { ai } from "~/integrations/tanstack-query/generated/catalog/ai.gen";
import { entityMutation } from "~/integrations/tanstack-query/generated/catalog/entityMutation.gen";
import { meal } from "~/integrations/tanstack-query/generated/catalog/meal.gen";
import { formatDateSpan } from "~/lib/date-span";
import type { EntityBrowserMutationResult } from "~/server/entity-kernel/contracts";
import type { ComboboxItem } from "~/ui/combobox/combobox-types";
import { DatePickerInput } from "~/ui/date-picker-input";
import { Row, Stack } from "~/ui/layout";
import { Overlay } from "~/ui/overlays/overlay";
import { Button } from "~/ui/primitives/button";
import { Checkbox } from "~/ui/primitives/checkbox";
import { Label } from "~/ui/primitives/label";

import { mealListLabel } from "./meal-format";
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
const createdMealReceipt = mealOut.pick({ id: true, date: true });
function createdMeal(result: EntityBrowserMutationResult) {
  return result.action === "create" && result.entity === "meal"
    ? createdMealReceipt.parse(result.item)
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
  const queryClient = useQueryClient();
  useEntityMetadata("meal");
  const mealTypeOptions = useMemo(
    () => fieldEnumOptions(queryClient, "meal", "mealType"),
    [queryClient],
  );
  const mealKindOptions = useMemo(
    () => fieldEnumOptions(queryClient, "meal", "mealKind"),
    [queryClient],
  );
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

  // The NEW_MEAL sentinel is not a meal code, so the record picker holds it
  // as-is ahead of the day's meal records.
  const mealItems = useMemo(
    (): ComboboxItem[] => [
      { id: NEW_MEAL, name: "Create a new meal" },
      ...(existingMeals.data?.map((meal) => {
        const mealKind = fieldValueOf(meal.fields.mealKind);
        const mealLabel = mealListLabel({
          ...meal,
          mealType: fieldValueOf(meal.fields.mealType),
        });
        // The picture only: the day is already chosen, so the row's date
        // projection would repeat it.
        const { id, shortcode, thumb } = buildRecordComboboxItem(
          queryClient,
          "meal",
          meal,
        );
        return {
          id,
          shortcode,
          thumb,
          // The kind rides the label for non-cooked meals so the consequence
          // is visible before selecting, not only after.
          name:
            mealKind === "cooked"
              ? `${mealLabel} (${countLabel(meal.recipes.length, "recipe")})`
              : `${mealLabel} — ${mealKind ? MEAL_KIND_LABELS[mealKind] : "Updating…"}`,
        };
      }) ?? []),
    ],
    [existingMeals.data, queryClient],
  );

  const selectedMeal: MealOut | undefined =
    target === NEW_MEAL
      ? undefined
      : existingMeals.data?.find((meal) => meal.id === target);
  // Planning a recipe into a meal you aren't cooking is contradictory, and it
  // loses the ingredients silently: only `cooked` meals feed the shopping list.
  const targetNotCooked =
    selectedMeal != null &&
    fieldValueOf(selectedMeal.fields.mealKind) !== "cooked";

  const onSuccess = (meal: { id: string; date: string }) => {
    invalidate();
    setOpen(false);
    toast.success(`Added to a meal on ${formatDateSpan(meal.date, null)}`, {
      action: {
        label: "View",
        onClick: () =>
          void navigate({
            to: entities.meal.routes.detail,
            params: entityDetailParams(meal.id),
          }),
      },
    });
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
  const isPending = createMeal.isPending || addRecipe.isPending;

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
    addRecipe.mutate({
      mealId: target,
      recipeId,
      scale: 1,
      convertToCooked: targetNotCooked && switchToCooked,
    });
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
      <Overlay
        open={open}
        onOpenChange={setOpen}
        size="md"
        title="Add to meal"
        description="Choose a day and an existing meal, or create a separate meal for this recipe."
        onCancel={() => setOpen(false)}
        primary={{
          label: target === NEW_MEAL ? "Create meal" : "Add to selected meal",
          pending: isPending,
          disabled: existingMeals.isLoading,
          onClick: submit,
        }}
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
            <Picker
              mode="choose"
              entity="meal"
              items={mealItems}
              value={mealItems.find((item) => item.id === target) ?? null}
              disabled={existingMeals.isLoading}
              setValue={(item) => setTarget(item?.id ?? NEW_MEAL)}
              label="meal"
            />
          </Stack>

          {target === NEW_MEAL && (
            <SuggestionVisitProvider>
              <Row gap="sm" wrap>
                <Stack gap="xs" className="min-w-40 flex-1">
                  <Label>Meal type</Label>
                  <Picker
                    mode="choose"
                    options={mealTypeOptions}
                    value={mealType}
                    onValueChange={(value) =>
                      setMealType(mealTypeFromPicker(value))
                    }
                    label="meal type"
                    clearable
                  />
                  <FieldSuggestionHint
                    renderValue={(value) =>
                      renderSuggestedListFieldValue(
                        queryClient,
                        "meal",
                        { id: "" },
                        "mealType",
                        value,
                      )
                    }
                    suggestion={suggestions.mealType ?? null}
                    applied={false}
                    currentValue={mealType}
                    currentLabel={
                      mealTypeOptions.find(
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
                  <Picker
                    mode="choose"
                    options={mealKindOptions}
                    value={mealKind}
                    onValueChange={(value) =>
                      setMealKind(mealKindFromPicker(value))
                    }
                    label="kind"
                  />
                  <FieldSuggestionHint
                    renderValue={(value) =>
                      renderSuggestedListFieldValue(
                        queryClient,
                        "meal",
                        { id: "" },
                        "mealKind",
                        value,
                      )
                    }
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
                  {MEAL_KIND_LABELS[
                    fieldValueOf(selectedMeal.fields.mealKind) ?? "cooked"
                  ].toLowerCase()}{" "}
                  meal, so its recipes aren't added to the shopping list.
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
      </Overlay>
    </>
  );
}

type MealOut = ListRowOf<"meal">;
