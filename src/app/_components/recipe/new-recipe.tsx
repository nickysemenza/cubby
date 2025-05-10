"use client";

import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { useState } from "react";
import { RecipeForm } from "./recipe-form";
import { useTRPC } from "~/trpc/react";
import { useMutation } from "@tanstack/react-query";
import { type RecipeCreateInput } from "~/schemas/recipe";

export default function NewRecipeForm() {
  const router = useRouter();
  const api = useTRPC();
  const [error, setError] = useState<string | undefined>(undefined);

  // Set up mutation for creating a recipe
  const createMutation = useMutation(
    api.recipe.create.mutationOptions({
      onSuccess: (data) => {
        toast.success("Recipe created successfully!");
        router.push(`/recipes/${data.id}`);
      },
      onError: (error) => {
        setError(error.message);
        toast.error("Failed to create recipe");
      },
    }),
  );

  const handleCreate = (data: RecipeCreateInput) => {
    createMutation.mutate(data);
  };

  return (
    <RecipeForm
      mode="create"
      onCreate={handleCreate}
      isPending={createMutation.isPending}
      error={error}
      onCancel={() => router.back()}
    />
  );
}
