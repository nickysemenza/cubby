import type { RecipeShortcode } from "@cubby/schemas/identifiers";
import type { MealOut } from "@cubby/schemas/meal";
import {
  MEAL_KIND_LABELS,
  type MealKind,
  type MealType,
} from "@cubby/schemas/meal-classification";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { format, parseISO } from "date-fns";
import { CalendarPlus, TriangleAlert } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { toast } from "sonner";
import { StaticPicker } from "~/app/_components/combobox/static-picker";
import { DatePickerInput } from "~/app/_components/date-picker-input";
import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { DialogFooter } from "~/components/ui/dialog";
import { Label } from "~/components/ui/label";
import { ResponsiveDialog } from "~/components/ui/responsive-dialog";
import { entities, entityDetailParams } from "~/entities/entities";
import { entityMutationOptionsFactory } from "~/entities/entity-contracts";
import {
  mealAddRecipeMutationOptions,
  mealDateRangeQueryOptions,
} from "./meal.functions";
import { mealListLabel } from "./meal-format";
import { mealKindOptions, mealTypeOptions } from "./meal-options";
import { useInvalidateMeals } from "./use-meal-mutations";

const NEW_MEAL = "new";

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
export function AddToMeal({ recipeId }: { recipeId: RecipeShortcode }) {
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
    ...mealDateRangeQueryOptions({ from: date, to: date }),
    enabled: open,
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
    entityMutationOptionsFactory("meal", "create")({ onSuccess }),
  );
  const addRecipe = useMutation(mealAddRecipeMutationOptions({ onSuccess }));
  const updateMeal = useMutation(
    entityMutationOptionsFactory("meal", "update")(),
  );
  const isPending =
    createMeal.isPending || addRecipe.isPending || updateMeal.isPending;

  const submit = async () => {
    if (target === NEW_MEAL) {
      createMeal.mutate({
        date,
        mealType,
        mealKind,
        recipes: [{ recipeId, scale: 1 }],
      });
      return;
    }
    // Re-kind first so the meal is never briefly a non-cooked meal holding a
    // recipe — that intermediate state is the one the shopping list drops.
    if (targetNotCooked && switchToCooked) {
      await updateMeal.mutateAsync({
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
        <CalendarPlus className="size-4" />
        Add to meal
      </Button>
      <ResponsiveDialog
        open={open}
        onOpenChange={setOpen}
        size="md"
        title="Add to meal"
        description="Choose a day and an existing meal, or create a separate meal for this recipe."
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
            <Row gap="sm" wrap>
              <Stack gap="xs" className="min-w-40 flex-1">
                <Label>Meal type</Label>
                <StaticPicker
                  items={mealTypeOptions}
                  value={mealType}
                  onValueChange={(value) =>
                    setMealType(value as MealType | null)
                  }
                  label="meal type"
                  clearable
                />
              </Stack>
              <Stack gap="xs" className="min-w-40 flex-1">
                <Label>Kind</Label>
                <StaticPicker
                  items={mealKindOptions}
                  value={mealKind}
                  onValueChange={(value) =>
                    setMealKind((value ?? "cooked") as MealKind)
                  }
                  label="kind"
                />
              </Stack>
            </Row>
          )}

          {targetNotCooked && selectedMeal && (
            <Stack
              gap="snug"
              className="border border-warning/40 bg-warning/5 px-2 py-2 text-2xs"
            >
              <Row gap="xs" align="center" className="text-warning-ink">
                <TriangleAlert className="size-3 shrink-0" />
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
                <Label htmlFor={switchId} className="font-normal text-2xs">
                  Switch it to Cooked when adding
                </Label>
              </Row>
            </Stack>
          )}
        </Stack>
        <DialogFooter>
          <Row gap="sm">
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={isPending || existingMeals.isLoading}
              onClick={() => void submit()}
            >
              {target === NEW_MEAL ? "Create meal" : "Add to selected meal"}
            </Button>
          </Row>
        </DialogFooter>
      </ResponsiveDialog>
    </>
  );
}
