import type { RecipeOut, RecipeUpdateInput } from "@cubby/schemas/recipe";
import { toast } from "sonner";
import { useTRPC } from "~/integrations/trpc/react";
import { recipeAllMutationInvalidateKeys } from "~/lib/query-keys";
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
    entity: "recipe",
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
