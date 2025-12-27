import type { z } from "zod";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import type { ingredientBase } from "~/schemas/ingredient";
import { useTRPC } from "~/trpc/react";
import { useEntityCreateMode } from "../hooks/useEntityMode";
import { IngredientForm } from "./ingredient-form";

export function NewIngredient() {
  const api = useTRPC();

  const { error, isPending, handleCreate, handleCancel } = useEntityCreateMode<
    z.infer<typeof ingredientBase>,
    { id: string }
  >("ingredient", api.ingredient.create.mutationOptions());

  return (
    <Card>
      <CardHeader>
        <CardTitle>Create New Ingredient</CardTitle>
      </CardHeader>
      <CardContent>
        <IngredientForm
          mode="create"
          isPending={isPending}
          error={error}
          onCreate={handleCreate}
          onCancel={handleCancel}
        />
      </CardContent>
    </Card>
  );
}
