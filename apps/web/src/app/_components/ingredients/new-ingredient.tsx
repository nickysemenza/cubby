import type { z } from "zod";
import { EntityCreateWrapper } from "~/components/entity/entity-create-wrapper";
import type { ingredientBase } from "~/schemas/ingredient";
import { useTRPC } from "~/trpc/react";
import { IngredientForm } from "./ingredient-form";

export function NewIngredient() {
  const api = useTRPC();

  return (
    <EntityCreateWrapper<z.infer<typeof ingredientBase>, { id: string }>
      entity="ingredient"
      mutationOptions={api.ingredient.create.mutationOptions()}
    >
      {({ isPending, error, onCreate, onCancel }) => (
        <IngredientForm
          mode="create"
          isPending={isPending}
          error={error}
          onCreate={onCreate}
          onCancel={onCancel}
        />
      )}
    </EntityCreateWrapper>
  );
}
