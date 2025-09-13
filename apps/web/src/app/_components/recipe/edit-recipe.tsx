"use client";

import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { useState } from "react";
import { RecipeForm } from "./recipe-form";
import { useTRPC } from "~/trpc/react";
import { useMutation } from "@tanstack/react-query";
import { RecipeOut, RecipeUpdateInput } from "~/schemas/recipe";

interface EditRecipeFormProps {
  recipe: RecipeOut;
  onCancel: () => void;
}

export default function EditRecipeForm({
  recipe,
  onCancel,
}: EditRecipeFormProps) {
  const router = useRouter();
  const api = useTRPC();
  const [error, setError] = useState<string | undefined>(undefined);

  // Set up mutation for updating a recipe
  const updateMutation = useMutation(
    api.recipe.update.mutationOptions({
      onSuccess: () => {
        toast.success("Recipe updated successfully!");
        router.refresh(); // Refresh page data
        onCancel(); // Close the edit mode/dialog
      },
      onError: (error) => {
        setError(error.message);
        toast.error("Failed to update recipe");
      },
    }),
  );

  const handleUpdate = (data: RecipeUpdateInput) => {
    updateMutation.mutate(data);
  };

  return (
    <RecipeForm
      mode="edit"
      entity={recipe}
      onEdit={handleUpdate}
      isPending={updateMutation.isPending}
      error={error}
      onCancel={onCancel}
    />
  );
}
