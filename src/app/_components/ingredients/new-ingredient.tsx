"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { IngredientForm, type CreateIngredientData } from "./ingredient-form";
import { useTRPC } from "~/trpc/react";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";

import { useMutation } from "@tanstack/react-query";

export function NewIngredient() {
  const api = useTRPC();
  const router = useRouter();
  const [error, setError] = useState<string | undefined>();

  const createIngredient = useMutation(
    api.ingredient.create.mutationOptions({
      onSuccess: (ingredient) => {
        router.push(`/ingredients/${ingredient.id}`);
      },
      onError: (error) => {
        setError(error.message);
      },
    }),
  );

  const handleCreate = (data: CreateIngredientData) => {
    createIngredient.mutate(data);
  };

  const handleCancel = () => {
    router.push("/ingredients");
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