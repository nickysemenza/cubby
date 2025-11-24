"use client";

import { useRouter } from "next/navigation";
import { RecipeForm } from "./recipe-form";
import { useTRPC } from "~/trpc/react";
import { type RecipeCreateInput } from "~/schemas/recipe";
import { toast } from "sonner";
import { useEntityCreateMode } from "../hooks/useEntityMode";

export default function NewRecipeForm() {
  const router = useRouter();
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
      onCancel={() => router.back()}
    />
  );
}
