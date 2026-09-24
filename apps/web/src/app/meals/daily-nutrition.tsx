import {
  type MealShortcode,
  type RecipeShortcode,
} from "@cubby/schemas/identifiers";
import {
  MEAL_TYPE_LABELS,
  mealTypeSchema,
  type MealType,
} from "@cubby/schemas/meal-classification";
import { CaretLeftIcon as ChevronLeft } from "@phosphor-icons/react/dist/csr/CaretLeft";
import { CaretRightIcon as ChevronRight } from "@phosphor-icons/react/dist/csr/CaretRight";
import { PlusIcon as Plus } from "@phosphor-icons/react/dist/csr/Plus";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { addDays, format, parseISO } from "date-fns";
import { useState } from "react";

import { StaticPicker } from "~/app/_components/combobox/static-picker";
import { DatePickerInput } from "~/app/_components/date-picker-input";
import { Row, Stack } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { ResponsiveDialog } from "~/components/ui/responsive-dialog";
import { entityMutationOptionsFactory } from "~/entities/entity-contracts";
import { useHouseholdToday } from "~/hooks/use-household-today";
import { getErrorMessage } from "~/lib/error-utils";

import { AddFoodDialog } from "./add-food-dialog";
import { NutritionSummary } from "./meal-nutrition-summary";
import { RecipeFoodDialog } from "./meal-preparation/recipe-food-dialog";
import { meal } from "./meal.functions";

export function DailyNutrition({
  date,
  initialToday,
  onDateChange,
}: {
  date?: string;
  initialToday: string;
  onDateChange: (date: string) => void;
}) {
  const today = useHouseholdToday(initialToday) ?? initialToday;
  const selectedDate = date ?? today;
  const [adding, setAdding] = useState(false);
  const move = (days: number) =>
    onDateChange(format(addDays(parseISO(selectedDate), days), "yyyy-MM-dd"));
  return (
    <Stack gap="lg">
      <Row justify="between" gap="md" className="flex-wrap">
        <Row gap="sm" className="flex-wrap">
          <Button
            variant="outline"
            className="min-h-11 min-w-11"
            aria-label="Previous day"
            onClick={() => move(-1)}
          >
            <ChevronLeft className="size-4" />
          </Button>
          <DatePickerInput
            value={selectedDate}
            onChange={(value) => {
              if (value) onDateChange(value);
            }}
            aria-label="Nutrition date"
            className="min-h-11 w-44"
          />
          <Button
            variant="outline"
            className="min-h-11 min-w-11"
            aria-label="Next day"
            onClick={() => move(1)}
          >
            <ChevronRight className="size-4" />
          </Button>
          <Button
            variant="ghost"
            className="min-h-11"
            onClick={() => onDateChange(today)}
          >
            Today
          </Button>
          {selectedDate > today && <Badge variant="outline">Planned</Badge>}
        </Row>
        <Button className="min-h-11" onClick={() => setAdding(true)}>
          <Plus className="size-4" />
          Add food
        </Button>
      </Row>
      <NutritionSummary input={{ date: selectedDate }} />
      {adding && (
        <DailyAddFood
          key={selectedDate}
          date={selectedDate}
          onClose={() => setAdding(false)}
        />
      )}
    </Stack>
  );
}

function DailyAddFood({
  date,
  onClose,
}: {
  date: string;
  onClose: () => void;
}) {
  const choices = useQuery(meal.getNutrition.queryOptions({ date }));
  const [target, setTarget] = useState<MealShortcode | null>(null);
  const [newMeal, setNewMeal] = useState(false);
  const [name, setName] = useState("");
  const [mealType, setMealType] = useState<MealType>("snack");
  const [recipeId, setRecipeId] = useState<RecipeShortcode | null>(null);
  const create = useMutation(
    entityMutationOptionsFactory(
      "meal",
      "create",
    )({ onSuccess: (created) => setTarget(created.id) }),
  );
  if (target)
    return recipeId ? (
      <RecipeFoodDialog
        mealId={target}
        date={date}
        recipeId={recipeId}
        onClose={onClose}
      />
    ) : (
      <AddFoodDialog
        mealId={target}
        date={date}
        open
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
        onRecipe={setRecipeId}
      />
    );
  return (
    <ResponsiveDialog
      open
      onOpenChange={(open) => {
        if (!open && !create.isPending) onClose();
      }}
      title="Add food to a meal"
      description={`Choose an occasion for ${date}.`}
    >
      <Stack gap="md">
        {choices.error && (
          <p role="alert" className="text-sm text-destructive">
            {getErrorMessage(choices.error)}
          </p>
        )}
        {choices.isLoading && <output>Loading meals…</output>}
        {choices.data?.meals.map((m) => (
          <Button
            key={m.id}
            variant="outline"
            className="min-h-11 justify-start"
            onClick={() => setTarget(m.id)}
          >
            {m.name ?? (m.mealType ? MEAL_TYPE_LABELS[m.mealType] : "Meal")}
          </Button>
        ))}
        {!newMeal ? (
          <Button
            className="min-h-11"
            variant="outline"
            onClick={() => setNewMeal(true)}
          >
            <Plus className="size-4" />
            New meal or snack
          </Button>
        ) : (
          <>
            <StaticPicker
              label="Occasion"
              items={mealTypeSchema.options.map((value) => ({
                value,
                label: MEAL_TYPE_LABELS[value],
              }))}
              value={mealType}
              onValueChange={(value) => {
                if (value) setMealType(mealTypeSchema.parse(value));
              }}
              clearable={false}
            />
            <label
              htmlFor="nutrition-new-meal-name"
              className="grid gap-2 text-sm"
            >
              Name (optional)
              <Input
                className="min-h-11"
                value={name}
                onChange={(event) => setName(event.target.value)}
                id="nutrition-new-meal-name"
                placeholder="e.g. Afternoon snack"
              />
            </label>
            {create.error && (
              <p role="alert" className="text-sm text-destructive">
                {getErrorMessage(create.error)}
              </p>
            )}
            <Button
              className="min-h-11"
              disabled={create.isPending}
              onClick={() =>
                create.mutate({
                  date,
                  name: name.trim() || null,
                  mealType,
                  mealKind: "cooked",
                })
              }
            >
              {create.isPending ? "Creating…" : "Continue to food"}
            </Button>
          </>
        )}
      </Stack>
    </ResponsiveDialog>
  );
}

export function TodayNutrition({ initialDate }: { initialDate: string }) {
  const today = useHouseholdToday(initialDate) ?? initialDate;
  return (
    <section aria-label="Today's nutrition">
      <Row justify="between" gap="sm" className="mb-3">
        <h2 className="text-base font-semibold">Today’s nutrition</h2>
        <Link
          to="/meals"
          search={{ view: "nutrition", date: today }}
          className="py-3 text-sm text-primary hover:underline"
        >
          View day
        </Link>
      </Row>
      <NutritionSummary input={{ date: today }} compact />
    </section>
  );
}
