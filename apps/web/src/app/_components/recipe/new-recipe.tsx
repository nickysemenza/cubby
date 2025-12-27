import { toast } from "sonner";
import type { RecipeCreateInput } from "~/schemas/recipe";
import { useTRPC } from "~/trpc/react";
import { useEntityCreateMode } from "../hooks/useEntityMode";
import { RecipeForm } from "./recipe-form";

export default function NewRecipeForm() {
  const api = useTRPC();

  const { error, isPending, handleCreate } = useEntityCreateMode<
    RecipeCreateInput,
    { id: string }
  >("recipe", api.recipe.create.mutationOptions(), {
    onSuccess: () => {
      toast.success("Recipe created successfully!");
    },
    onError: () => {
      toast.error("Failed to create recipe");
    },
  });

  return (
    <RecipeForm
      mode="create"
      onCreate={handleCreate}
      isPending={isPending}
      error={error}
      onCancel={() => window.history.back()}
    />
  );
}
