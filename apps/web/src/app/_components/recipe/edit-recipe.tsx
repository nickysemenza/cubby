import { toast } from "sonner";
import { queryKeys } from "~/lib/query-keys";
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
    // Only invalidate recipe queries to avoid triggering problematic ingredient queries
    invalidateKeys: [queryKeys.recipe.all],
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
