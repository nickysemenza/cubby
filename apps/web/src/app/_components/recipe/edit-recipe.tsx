import { toast } from "sonner";
import type { RecipeOut, RecipeUpdateInput } from "~/schemas/recipe";
import { useTRPC } from "~/trpc/react";
import { useEditMode } from "../hooks/useEditMode";
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

  const { error, isPending, handleEdit } = useEditMode<RecipeUpdateInput>({
    mutationOptions: api.recipe.update.mutationOptions(),
    onSuccess: () => {
      toast.success("Recipe updated successfully!");
      onCancel();
    },
  });

  return (
    <RecipeForm
      mode="edit"
      entity={recipe}
      onEdit={handleEdit}
      isPending={isPending}
      error={error}
      onCancel={onCancel}
    />
  );
}
