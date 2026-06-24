import type { RecipeId } from "@cubby/schemas/identifiers";
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { addDays, format, parseISO } from "date-fns";
import { CalendarPlus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { useTRPC } from "~/trpc/react";
import { useInvalidateMeals } from "./use-meal-mutations";

/**
 * "Add to Meal ▾" — plans the current recipe onto a day. Creates a new meal on
 * the chosen date containing this recipe at 1×. Lives on the recipe detail page.
 */
export function AddToMeal({ recipeId }: { recipeId: RecipeId }) {
  const api = useTRPC();
  const navigate = useNavigate();
  const invalidate = useInvalidateMeals();

  const createMeal = useMutation(
    api.meal.create.mutationOptions({
      onSuccess: (meal) => {
        invalidate();
        toast.success(
          `Added to a meal on ${format(parseISO(meal.date), "EEE, MMM d")}`,
          {
            action: {
              label: "View",
              onClick: () =>
                void navigate({ to: "/meals/$id", params: { id: meal.id } }),
            },
          },
        );
      },
    }),
  );

  // Accepts a plain "YYYY-MM-DD" string so there's no Date round-trip (and no
  // UTC-midnight timezone shift).
  const addOn = (dateStr: string) =>
    createMeal.mutate({ date: dateStr, recipes: [{ recipeId, scale: 1 }] });

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button type="button" variant="outline" size="sm" />}
      >
        <CalendarPlus className="size-4" />
        Add to meal
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Plan for…</DropdownMenuLabel>
          <DropdownMenuItem
            onClick={() => addOn(format(new Date(), "yyyy-MM-dd"))}
          >
            Today
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => addOn(format(addDays(new Date(), 1), "yyyy-MM-dd"))}
          >
            Tomorrow
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <div className="px-2 py-2">
          <span className="mb-1 block text-muted-foreground text-xs">
            Pick a date
          </span>
          <input
            type="date"
            className="w-full rounded-md border bg-input/20 px-2 py-1 text-sm"
            onChange={(e) => {
              // <input type="date"> value is already YYYY-MM-DD — use it directly.
              if (e.target.value) addOn(e.target.value);
            }}
          />
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
