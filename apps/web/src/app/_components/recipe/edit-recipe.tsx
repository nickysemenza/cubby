import type { RecipeOut, RecipeUpdateInput } from "@cubby/schemas/recipe";
import { toast } from "sonner";

import { useEntityDetailController } from "~/entities/editing/use-entity-detail-controller";

import { RecipeForm } from "./recipe-form";

interface EditRecipeFormProps {
  recipe: RecipeOut;
  onCancel: () => void;
}

export default function EditRecipeForm({
  recipe,
  onCancel,
}: EditRecipeFormProps) {
  const { error, isPending, submit } = useEntityDetailController<
    "recipe",
    RecipeUpdateInput
  >({
    entity: "recipe",
    entityId: recipe.id,
    onSuccess: () => {
      toast.success("Recipe saved.");
      onCancel();
    },
  });

  return (
    <RecipeForm
      mode="edit"
      entity={recipe}
      onEdit={submit}
      isPending={isPending}
      error={error}
      onCancel={onCancel}
    />
  );
}
