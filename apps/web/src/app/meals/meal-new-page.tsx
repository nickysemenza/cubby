import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { format } from "date-fns";
import { useId, useState } from "react";
import { Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { useTRPC } from "~/trpc/react";
import { useInvalidateMeals } from "./use-meal-mutations";

export function MealNewPage() {
  const api = useTRPC();
  const navigate = useNavigate();
  const invalidate = useInvalidateMeals();

  const [date, setDate] = useState(() => format(new Date(), "yyyy-MM-dd"));
  const [name, setName] = useState("");
  const dateId = useId();
  const nameId = useId();

  const createMeal = useMutation(
    api.meal.create.mutationOptions({
      onSuccess: (meal) => {
        invalidate();
        void navigate({ to: "/meals/$id", params: { id: meal.id } });
      },
    }),
  );

  return (
    <Stack
      as="form"
      className="max-w-sm"
      onSubmit={(e) => {
        e.preventDefault();
        if (!date) return;
        createMeal.mutate({
          date, // already "YYYY-MM-DD"
          name: name.trim() || null,
        });
      }}
    >
      <Stack gap="xs">
        <label htmlFor={dateId} className="text-muted-foreground text-sm">
          Date
        </label>
        <Input
          id={dateId}
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          required
        />
      </Stack>
      <Stack gap="xs">
        <label htmlFor={nameId} className="text-muted-foreground text-sm">
          Name (optional)
        </label>
        <Input
          id={nameId}
          value={name}
          placeholder="e.g. Dinner"
          onChange={(e) => setName(e.target.value)}
        />
      </Stack>
      <Button type="submit" disabled={createMeal.isPending}>
        Create meal
      </Button>
    </Stack>
  );
}
