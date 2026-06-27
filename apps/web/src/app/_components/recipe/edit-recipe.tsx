import type { RecipeUpdateInput } from "@cubby/schemas/recipe";
import type { RecipeOut } from "@cubby/schemas/recipe-responses";
import { toast } from "sonner";
import { recipeAllMutationInvalidateKeys } from "~/lib/query-keys";
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
    entityId: recipe.id,
    mutationOptions: api.recipe.update.mutationOptions(),
    onSuccess: () => {
      toast.success("Recipe saved.");
      onCancel();
    },
    // Only invalidate recipe queries to avoid triggering problematic ingredient queries
    invalidateKeys: recipeAllMutationInvalidateKeys,
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
