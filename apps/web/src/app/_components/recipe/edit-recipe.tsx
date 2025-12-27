import { toast } from "sonner";
import type { RecipeOut, RecipeUpdateInput } from "~/schemas/recipe";
import { useTRPC } from "~/trpc/react";
import { useEntityEditMode } from "../hooks/useEntityMode";
import { RecipeForm } from "./recipe-form";

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
