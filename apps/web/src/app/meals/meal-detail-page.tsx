import type { MealId } from "@cubby/schemas/identifiers";
import type { MealRecipeOut } from "@cubby/schemas/meal";
import { MAX_PAGE_SIZE } from "@cubby/schemas/pagination";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { format, parseISO } from "date-fns";
import { Trash2 } from "lucide-react";
import { useState } from "react";
import { useActionMutation } from "~/app/_components/hooks/useActionMutation";
import { useEntityDelete } from "~/app/_components/hooks/useEntityDelete";
import { SimpleLoading } from "~/components/feedback/loading-skeletons";
import { Row, Stack } from "~/components/layout";
import type { DetailHeroStat } from "~/components/layouts/page-hero";
import { Page } from "~/components/page/Page";
import { Button } from "~/components/ui/button";
import { FilterableCombobox } from "~/components/ui/combobox";
import { Description } from "~/components/ui/description";
import { Empty, EmptyDescription, EmptyTitle } from "~/components/ui/empty";
import { Input } from "~/components/ui/input";
import { mealMutationInvalidateKeys } from "~/lib/query-keys";
import { formatCurrency } from "~/lib/utils";
import { useTRPC } from "~/trpc/react";
import { useInvalidateMeals } from "./use-meal-mutations";

export function MealDetailPage({ mealId }: { mealId: MealId }) {
  const api = useTRPC();
  const invalidate = useInvalidateMeals();

  const {
    data: meal,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery(api.meal.getByID.queryOptions({ id: mealId }));

  // Recipe picker options.
  const { data: recipeList } = useQuery(
    api.recipe.list.queryOptions({
      filters: {},
      sort: { orderBy: "name", direction: "asc" },
      pagination: { pageIndex: 0, pageSize: MAX_PAGE_SIZE },
    }),
  );

  const updateMeal = useMutation(
    api.meal.update.mutationOptions({ onSuccess: invalidate }),
  );
  const addRecipe = useMutation(
    api.meal.addRecipe.mutationOptions({ onSuccess: invalidate }),
  );

  // Confirm + toast + optimistic removal, matching every other entity.
  const mealName = meal?.name
    ? meal.name
    : meal
      ? format(parseISO(meal.date), "EEE, MMM d")
      : "";
  const {
    DeleteDialog,
    openDeleteDialog,
    isPending: isDeleting,
  } = useEntityDelete({
    id: mealId,
    name: mealName,
    entityLabel: "Meal",
    mutationOptions: api.meal.delete.mutationOptions,
    invalidateKeys: mealMutationInvalidateKeys,
    redirectTo: "/meals",
  });

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
  const recipeItems = (recipeList?.items ?? []).map((r) => ({
    value: r.id,
    label: r.name,
  }));

  const heroStats: DetailHeroStat[] = [
    {
      label: "Cost",
      value:
        meal.totals.pending && meal.totals.costTotal === 0
          ? "—"
          : `${formatCurrency(meal.totals.costTotal)}${meal.totals.pending ? "+" : ""}`,
    },
    { label: "Calories", value: Math.round(meal.totals.caloriesTotal) },
    { label: "Recipes", value: meal.recipes.length },
  ];

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
      actions={
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="text-destructive"
          disabled={isDeleting}
          onClick={openDeleteDialog}
        >
          <Trash2 className="size-4" />
          Delete meal
        </Button>
      }
    >
      <DeleteDialog />
      <Stack>
        <Row align="end" wrap gap="md">
          <Stack gap="sm">
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
            <Input
              type="date"
              value={meal.date}
              className="h-8 w-44"
              onChange={(e) => {
                if (!e.target.value) return;
                updateMeal.mutate({
                  id: mealId,
                  data: { date: e.target.value },
                });
              }}
            />
          </Stack>
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
      </Stack>
    </Page>
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
  const removeRecipe = useActionMutation({
    mutationFn: api.meal.removeRecipe.mutationOptions,
    success: `Removed ${mr.recipe.name}`,
    onSuccess: onChanged,
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
