import { type RecipeUpdateInput } from "@cubby/schemas/entities/recipe";
import { toast } from "sonner";

import { useEntityDetailController } from "~/entity/editing/use-entity-detail-controller";
import type { DetailRecordOf } from "~/entity/entity-detail/detail-record";

import { RecipeForm } from "./recipe-form/index";

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

type RecipeOut = DetailRecordOf<"recipe">;
