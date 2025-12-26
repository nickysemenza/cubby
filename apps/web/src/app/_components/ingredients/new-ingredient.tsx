"use client";
import { IngredientForm } from "./ingredient-form";
import type { z } from "zod";
import type { ingredientBase } from "~/schemas/ingredient";
import { useTRPC } from "~/trpc/react";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { useEntityCreateMode } from "../hooks/useEntityMode";

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
