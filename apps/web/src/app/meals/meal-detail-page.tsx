import type { MealId } from "@cubby/schemas/identifiers";
import type { MealRecipeOut } from "@cubby/schemas/meal-responses";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Trash2 } from "lucide-react";
import { useState } from "react";
import { SimpleLoading } from "~/components/feedback/loading-skeletons";
import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { FilterableCombobox } from "~/components/ui/combobox";
import { Description } from "~/components/ui/description";
import { Input } from "~/components/ui/input";
import { formatCurrency } from "~/lib/utils";
import { useTRPC } from "~/trpc/react";
import { useInvalidateMeals } from "./use-meal-mutations";

export function MealDetailPage({ mealId }: { mealId: MealId }) {
  const api = useTRPC();
  const navigate = useNavigate();
  const invalidate = useInvalidateMeals();

  const { data: meal, isLoading } = useQuery(
    api.meal.getByID.queryOptions({ id: mealId }),
  );

  // Recipe picker options.
  const { data: recipeList } = useQuery(
    api.recipe.list.queryOptions({
      filters: {},
      sort: { orderBy: "name", direction: "asc" },
      pagination: { pageIndex: 0, pageSize: 500 },
    }),
  );

  const updateMeal = useMutation(
    api.meal.update.mutationOptions({ onSuccess: invalidate }),
  );
  const addRecipe = useMutation(
    api.meal.addRecipe.mutationOptions({ onSuccess: invalidate }),
  );
  const deleteMeal = useMutation(
    api.meal.delete.mutationOptions({
      onSuccess: () => {
        invalidate();
        void navigate({ to: "/meals" });
      },
    }),
  );

  const [name, setName] = useState<string | null>(null);

  if (isLoading) return <SimpleLoading text="Loading meal..." />;
  if (!meal) return <Description>Meal not found.</Description>;

  const nameValue = name ?? meal.name ?? "";
  const recipeItems = (recipeList?.items ?? []).map((r) => ({
    value: r.id,
    label: r.name,
  }));

  return (
    <Stack>
      <Link
        to="/meals"
        className="inline-flex items-center gap-1 text-muted-foreground text-sm hover:underline"
      >
        ← Meals
      </Link>
      <Row align="end" justify="between" wrap gap="md">
        <div className="flex flex-col gap-2">
          <Input
            value={nameValue}
            placeholder="Meal name (optional)"
            className="h-9 w-64 font-medium"
            onChange={(e) => setName(e.target.value)}
            onBlur={() => {
              const next = nameValue.trim() || null;
              if (next !== (meal.name ?? null)) {
                updateMeal.mutate({ id: mealId, data: { name: next } });
              }
            }}
          />
          <input
            type="date"
            value={meal.date}
            className="w-44 rounded-md border bg-input/20 px-2 py-1 text-sm"
            onChange={(e) => {
              if (!e.target.value) return;
              updateMeal.mutate({
                id: mealId,
                data: { date: e.target.value },
              });
            }}
          />
        </div>
        <div className="text-right">
          <div className="font-semibold text-lg tabular-nums">
            {meal.totals.pending && meal.totals.costTotal === 0
              ? "—"
              : `${formatCurrency(meal.totals.costTotal)}${meal.totals.pending ? "+" : ""}`}
          </div>
          <Description as="div" size="xs">
            {Math.round(meal.totals.caloriesTotal)} cal
            {meal.totals.pending ? " (some recipes uncosted)" : ""}
          </Description>
        </div>
      </Row>

      <Stack gap="sm">
        {meal.recipes.length === 0 ? (
          <Description>No recipes yet — add one below.</Description>
        ) : (
          meal.recipes.map((mr) => (
            <RecipeRow key={mr.id} mr={mr} onChanged={invalidate} />
          ))
        )}
      </Stack>

      <div className="max-w-sm">
        <Description as="span" size="xs" className="mb-1 block">
          Add a recipe
        </Description>
        <FilterableCombobox
          items={recipeItems}
          value={null}
          placeholder="Search recipes…"
          disabled={addRecipe.isPending}
          onValueChange={(recipeId) => {
            if (!recipeId) return;
            // tRPC's input type for a branded-uuid field is plain string.
            addRecipe.mutate({ mealId, recipeId, scale: 1 });
          }}
        />
      </div>

      <div className="border-t pt-4">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="text-destructive"
          disabled={deleteMeal.isPending}
          onClick={() => deleteMeal.mutate({ ids: [mealId] })}
        >
          <Trash2 className="size-4" />
          Delete meal
        </Button>
      </div>
    </Stack>
  );
}

function RecipeRow({
  mr,
  onChanged,
}: {
  mr: MealRecipeOut;
  onChanged: () => void;
}) {
  const api = useTRPC();
  const [scale, setScale] = useState(String(mr.scale));

  const updateRecipe = useMutation(
    api.meal.updateRecipe.mutationOptions({ onSuccess: onChanged }),
  );
  const removeRecipe = useMutation(
    api.meal.removeRecipe.mutationOptions({ onSuccess: onChanged }),
  );

  const commitScale = () => {
    const next = Number(scale);
    if (Number.isFinite(next) && next >= 0.01 && next !== mr.scale) {
      updateRecipe.mutate({ id: mr.id, scale: next });
    } else {
      setScale(String(mr.scale)); // reset invalid input
    }
  };

  return (
    <Row
      align="center"
      gap="sm"
      className="rounded-lg border border-[var(--border)] p-2"
    >
      <Link
        to="/recipes/$id"
        params={{ id: mr.recipeId }}
        className="flex-1 truncate font-medium text-sm hover:underline"
      >
        {mr.recipe.name}
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
        <span className="text-muted-foreground text-xs">×</span>
      </Row>
      <span className="w-16 text-right text-sm tabular-nums">
        {mr.scaledTotals ? formatCurrency(mr.scaledTotals.costTotal) : "—"}
      </span>
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
