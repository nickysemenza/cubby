"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { IngredientForm } from "./ingredient-form";
import { z } from "zod";
import { ingredientBase } from "~/schemas/ingredient";
import { useTRPC } from "~/trpc/react";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { entities } from "~/entities/entities";

import { useMutation } from "@tanstack/react-query";

export function NewIngredient() {
  const api = useTRPC();
  const router = useRouter();
  const [error, setError] = useState<string | undefined>();

  const createIngredient = useMutation(
    api.ingredient.create.mutationOptions({
      onSuccess: (ingredient) => {
        router.push(`/${entities.ingredient.basePath}/${ingredient.id}`);
      },
      onError: (error) => {
        setError(error.message);
      },
    }),
  );

  const handleCreate = (data: z.infer<typeof ingredientBase>) => {
    createIngredient.mutate(data);
  };

  const handleCancel = () => {
    router.push(`/${entities.ingredient.basePath}`);
  };

  return (
    <div className="container mx-auto py-10">
      <Card>
        <CardHeader>
          <CardTitle>Create New Ingredient</CardTitle>
        </CardHeader>
        <CardContent>
          <IngredientForm
            mode="create"
            isPending={createIngredient.isPending}
            error={error}
            onCreate={handleCreate}
            onCancel={handleCancel}
          />
        </CardContent>
      </Card>
    </div>
  );
}
