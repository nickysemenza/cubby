import type { MealRecipeId, MealShortcode } from "@cubby/schemas/identifiers";
import type {
  MealNutritionFood,
  MealNutritionInput,
  MealNutritionPerson,
} from "@cubby/schemas/meal";
import { MEAL_TYPE_LABELS } from "@cubby/schemas/meal-classification";
import {
  hasKnownEstimate,
  type MeasureEstimate,
  type NutritionTotals,
} from "@cubby/schemas/nutrition";
import { PencilIcon as Pencil } from "@phosphor-icons/react/dist/csr/Pencil";
import { TrashIcon as Trash2 } from "@phosphor-icons/react/dist/csr/Trash";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";

import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { Description } from "~/components/ui/description";
import { entityDetailLink } from "~/entities/entities";
import { getErrorMessage } from "~/lib/error-utils";
import { estimateStatusText, formatEstimate } from "~/lib/nutrition-format";

import { AddFoodDialog } from "./add-food-dialog";
import { FoodAmountReadout } from "./food-amount-editor";
import { MealNutritionEstimates } from "./meal-nutrition";
import { meal } from "./meal.functions";

const MACROS = [
  { key: "kcal", label: "Calories", unit: "kcal" },
  { key: "protein", label: "Protein", unit: "g" },
  { key: "carbs", label: "Carbs", unit: "g" },
  { key: "fat", label: "Fat", unit: "g" },
] as const;
const number = (value: number) => Number(value.toFixed(1)).toLocaleString();
function compactEstimate(estimate: MeasureEstimate, key: string) {
  if (!hasKnownEstimate(estimate)) return "—";
  const format =
    key === "kcal"
      ? (value: number) => Math.round(value).toLocaleString()
      : number;
  const value =
    estimate.upper != null && estimate.upper !== estimate.lower
      ? `${format(estimate.lower)}–${format(estimate.upper)}`
      : format(estimate.lower);
  return `${value}${estimate.status === "partial" ? "+" : ""}`;
}

function Macros({
  totals,
  prominent = false,
}: {
  totals: NutritionTotals;
  prominent?: boolean;
}) {
  return (
    <dl className="grid grid-cols-4 gap-2">
      {MACROS.map(({ key, label, unit }) => (
        <div key={key} className="min-w-0">
          <dt className="text-xs text-muted-foreground">{label}</dt>
          <dd
            className={`${prominent ? "text-xl font-semibold" : "text-sm"} tabular-nums`}
            title={formatEstimate(totals.nutrition[key], number)}
            aria-label={`${label}: ${formatEstimate(totals.nutrition[key], number)} ${unit}. ${estimateStatusText(totals.nutrition[key]) ?? ""}`}
          >
            {compactEstimate(totals.nutrition[key], key)}
            <span className="ml-1 text-xs font-normal text-muted-foreground">
              {unit}
            </span>
          </dd>
        </div>
      ))}
    </dl>
  );
}

function FoodName({ food }: { food: MealNutritionFood }) {
  if (food.sourceKind === "manual") return <span>{food.name}</span>;
  return (
    <Link
      {...(food.sourceKind === "recipe"
        ? entityDetailLink("recipe", food.recipeId)
        : food.sourceKind === "ingredient"
          ? entityDetailLink("ingredient", food.ingredientId)
          : entityDetailLink("product", food.productId))}
      className="hover:underline"
    >
      {food.name}
    </Link>
  );
}

function sourceEstimateDescription(food: MealNutritionFood): string {
  switch (food.sourceKind) {
    case "product":
      return "This entered amount stays fixed; estimates follow the product’s current nutrition and unit mappings.";
    case "ingredient":
      return "This entered amount stays fixed; estimates follow the ingredient’s currently linked products.";
    case "recipe":
      return "This entered amount stays fixed; estimates follow the current recipe and preparation yield.";
    case "manual":
      return "Nutrition was entered directly for this serving.";
  }
}

function NutritionPeople({
  people,
  compact = false,
  showMeals = false,
  onEdit,
  onRemove,
  recipeEditingAvailable = false,
}: {
  people: MealNutritionPerson[];
  compact?: boolean;
  recipeEditingAvailable?: boolean;
  showMeals?: boolean;
  onEdit?: (person: MealNutritionPerson, food: MealNutritionFood) => void;
  onRemove?: (
    food: Exclude<MealNutritionFood, { sourceKind: "recipe" }>,
  ) => void;
}) {
  if (!people.length)
    return (
      <p
        className={
          compact
            ? "py-1 text-xs text-muted-foreground"
            : "py-4 text-sm text-muted-foreground"
        }
      >
        {compact
          ? "No food logged yet. Add a portion to see nutrition."
          : "No portions entered yet. Add food and an amount for each person to see their macros."}
      </p>
    );
  const partial = people.some((p) =>
    MACROS.some(({ key }) => p.totals.nutrition[key].status === "partial"),
  );
  return (
    <Stack gap="md">
      <div className={compact ? "grid gap-4" : "grid gap-6 xl:grid-cols-2"}>
        {people.map((person) => (
          <section
            key={person.eater.id}
            aria-label={`${person.eater.name} nutrition`}
            className="min-w-0"
          >
            <h3 className="mb-3 text-base font-semibold">
              <Link
                {...entityDetailLink("ledgerParty", person.eater.id)}
                className="hover:underline"
              >
                {person.eater.name}
              </Link>
            </h3>
            <div className="border-y bg-muted/30 px-3 py-4">
              <Macros totals={person.totals} prominent={!compact} />
            </div>
            {!compact && (
              <>
                <ol className="divide-y">
                  {person.foods.map((food, index) => (
                    <li
                      key={
                        food.sourceKind === "recipe"
                          ? `${food.mealRecipeId}:${food.meal.id}`
                          : food.id
                      }
                      className="py-3"
                    >
                      {showMeals &&
                        person.foods[index - 1]?.meal.id !== food.meal.id && (
                          <div className="mb-4 border-b pb-3">
                            <h4 className="mb-2 text-sm font-semibold">
                              <Link
                                {...entityDetailLink("meal", food.meal.id)}
                                className="hover:underline"
                              >
                                {food.meal.name ??
                                  (food.meal.mealType
                                    ? MEAL_TYPE_LABELS[food.meal.mealType]
                                    : "Meal")}
                              </Link>
                            </h4>
                            {person.meals
                              .filter((m) => m.meal.id === food.meal.id)
                              .map((m) => (
                                <Macros key={m.meal.id} totals={m.totals} />
                              ))}
                          </div>
                        )}
                      <Row
                        justify="between"
                        align="start"
                        gap="sm"
                        className="mb-2"
                      >
                        <div className="min-w-0 text-sm font-medium break-words">
                          <FoodName food={food} />
                        </div>
                        <span className="shrink-0">
                          <FoodAmountReadout
                            amount={food.amount}
                            estimate={food}
                          />
                        </span>
                      </Row>
                      <Macros totals={food.totals} />
                      <details className="mt-2 text-xs">
                        <summary className="flex min-h-11 cursor-pointer items-center text-muted-foreground">
                          Details and editing
                        </summary>
                        <Stack gap="md">
                          <Description size="xs">
                            {sourceEstimateDescription(food)}
                          </Description>
                          <MealNutritionEstimates totals={food.totals} />
                          <Row gap="sm">
                            {food.sourceKind === "recipe" &&
                            !recipeEditingAvailable ? (
                              <Link
                                {...entityDetailLink("meal", food.meal.id)}
                                className="py-3 hover:underline"
                              >
                                Edit portion in meal
                              </Link>
                            ) : (
                              onEdit && (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="min-h-11"
                                  onClick={() => onEdit(person, food)}
                                >
                                  <Pencil className="size-3.5" />
                                  Edit amount
                                </Button>
                              )
                            )}
                            {food.sourceKind !== "recipe" && onRemove && (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="min-h-11"
                                onClick={() => onRemove(food)}
                              >
                                <Trash2 className="size-3.5" />
                                Remove food
                              </Button>
                            )}
                            {food.sourceKind === "recipe" &&
                              food.sourceMealId !== food.meal.id && (
                                <Link
                                  {...entityDetailLink(
                                    "meal",
                                    food.sourceMealId,
                                  )}
                                  className="py-3 hover:underline"
                                >
                                  Preparation meal
                                </Link>
                              )}
                          </Row>
                        </Stack>
                      </details>
                    </li>
                  ))}
                </ol>
                <details className="border-t text-xs">
                  <summary className="flex min-h-11 cursor-pointer items-center text-muted-foreground">
                    All nutrients for {person.eater.name}
                  </summary>
                  <MealNutritionEstimates totals={person.totals} />
                </details>
              </>
            )}
          </section>
        ))}
      </div>
      {partial && (
        <p className="text-xs text-muted-foreground">
          + means a known subtotal; some food nutrition is missing. — means
          unavailable.
        </p>
      )}
    </Stack>
  );
}

export function MealNutritionSummary({
  mealId,
  onEditRecipe,
}: {
  mealId: MealShortcode;
  onEditRecipe?: (id: MealRecipeId) => void;
}) {
  return <NutritionSummary input={{ mealId }} onEditRecipe={onEditRecipe} />;
}

export function NutritionSummary({
  input,
  compact,
  onEditRecipe,
}: {
  input: MealNutritionInput;
  compact?: boolean;
  onEditRecipe?: (id: MealRecipeId) => void;
}) {
  const query = useQuery(meal.getNutrition.queryOptions(input));
  const [editing, setEditing] =
    useState<Parameters<typeof AddFoodDialog>[0]["editing"]>();
  const remove = useMutation(
    meal.removeFood.mutationOptions({
      onSuccess: () => toast.success("Food removed"),
    }),
  );
  if (query.error)
    return (
      <Row gap="sm">
        <p role="alert" className="text-sm">
          Couldn’t load nutrition. {getErrorMessage(query.error)}
        </p>
        <Button variant="outline" onClick={() => void query.refetch()}>
          Retry
        </Button>
      </Row>
    );
  if (!query.data)
    return (
      <output className="block py-4 text-sm text-muted-foreground">
        Loading nutrition…
      </output>
    );
  return (
    <>
      <NutritionPeople
        people={query.data.people}
        compact={compact}
        recipeEditingAvailable={onEditRecipe != null}
        showMeals={"date" in input}
        onEdit={(person, food) => {
          if (food.sourceKind === "recipe") onEditRecipe?.(food.mealRecipeId);
          else setEditing({ food, eaterId: person.eater.id });
        }}
        onRemove={(food) => {
          if (!remove.isPending)
            remove.mutate({ mealId: food.meal.id, id: food.id });
        }}
      />
      {editing && (
        <AddFoodDialog
          mealId={editing.food.meal.id}
          date={editing.food.meal.date}
          open
          onOpenChange={(open) => {
            if (!open) setEditing(undefined);
          }}
          editing={editing}
        />
      )}
    </>
  );
}
