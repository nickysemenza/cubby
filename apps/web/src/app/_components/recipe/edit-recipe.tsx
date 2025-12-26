"use client";

import { toast } from "sonner";
import { RecipeForm } from "./recipe-form";
import { useTRPC } from "~/trpc/react";
import type { RecipeOut, RecipeUpdateInput } from "~/schemas/recipe";
import { useEntityEditMode } from "../hooks/useEntityMode";

interface EditRecipeFormProps {
  recipe: RecipeOut;
  onCancel: () => void;
}

export default function EditRecipeForm({
  recipe,
  onCancel,
}: EditRecipeFormProps) {
  const api = useTRPC();

  const { error, isPending, handleUpdate, handleCancel } = useEntityEditMode<
    RecipeUpdateInput,
    void
  >(api.recipe.update.mutationOptions(), onCancel, {
    onSuccess: () => {
      toast.success("Recipe updated successfully!");
    },
    onError: () => {
      toast.error("Failed to update recipe");
    },
  });

  return (
    <RecipeForm
      mode="edit"
      entity={recipe}
      onEdit={handleUpdate}
      isPending={isPending}
      error={error}
      onCancel={handleCancel}
    />
  );
}
