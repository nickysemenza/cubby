import type { RecipeShortcode } from "@cubby/schemas/identifiers";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { format, parseISO } from "date-fns";
import { CalendarPlus } from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";
import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Label } from "~/components/ui/label";
import { entities, entityDetailParams } from "~/entities/entities";
import { useTRPC } from "~/integrations/trpc/react";
import { useInvalidateMeals } from "./use-meal-mutations";

const NEW_MEAL = "new";

const today = () => format(new Date(), "yyyy-MM-dd");

const mealLabel = (meal: {
  name: string | null;
  recipes: { recipe: { name: string } }[];
}) =>
  meal.name ||
  meal.recipes.map((recipe) => recipe.recipe.name).join(", ") ||
  "Untitled meal";

/**
 * Plans the current recipe onto a day, either by extending one of that day's
 * existing named slots or by creating a new meal. Lives on recipe detail pages.
 */
export function AddToMeal({ recipeId }: { recipeId: RecipeShortcode }) {
  const api = useTRPC();
  const navigate = useNavigate();
  const invalidate = useInvalidateMeals();
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(today);
  const [target, setTarget] = useState(NEW_MEAL);
  const dateInputId = useId();
  const targetInputId = useId();

  const existingMeals = useQuery(
    api.meal.getByDateRange.queryOptions({ from: date, to: date }),
  );

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
    api.meal.create.mutationOptions({ onSuccess }),
  );
  const addRecipe = useMutation(
    api.meal.addRecipe.mutationOptions({ onSuccess }),
  );
  const isPending = createMeal.isPending || addRecipe.isPending;

  const submit = () => {
    if (target === NEW_MEAL) {
      createMeal.mutate({ date, recipes: [{ recipeId, scale: 1 }] });
      return;
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
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent size="md">
          <DialogHeader>
            <DialogTitle>Add to meal</DialogTitle>
            <DialogDescription>
              Choose a day and meal slot, or create a separate meal for this
              recipe.
            </DialogDescription>
          </DialogHeader>
          <Stack gap="sm">
            <Stack gap="xs">
              <Label htmlFor={dateInputId}>Day</Label>
              <input
                id={dateInputId}
                type="date"
                value={date}
                className="rounded-md border bg-input/20 px-2 py-1 text-sm"
                onChange={(event) => {
                  setDate(event.target.value);
                  setTarget(NEW_MEAL);
                }}
              />
            </Stack>
            <Stack gap="xs">
              <Label htmlFor={targetInputId}>Meal slot</Label>
              <select
                id={targetInputId}
                value={target}
                disabled={existingMeals.isLoading}
                className="rounded-md border bg-input/20 px-2 py-1 text-sm disabled:cursor-wait"
                onChange={(event) => setTarget(event.target.value)}
              >
                <option value={NEW_MEAL}>Create a new meal</option>
                {existingMeals.data?.map((meal) => (
                  <option key={meal.id} value={meal.id}>
                    {mealLabel(meal)} ({meal.recipes.length} recipe
                    {meal.recipes.length === 1 ? "" : "s"})
                  </option>
                ))}
              </select>
            </Stack>
          </Stack>
          <DialogFooter>
            <Row gap="sm">
              <Button variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                disabled={isPending || existingMeals.isLoading}
                onClick={submit}
              >
                {target === NEW_MEAL ? "Create meal" : "Add to selected meal"}
              </Button>
            </Row>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
