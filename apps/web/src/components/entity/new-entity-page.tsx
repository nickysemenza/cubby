import type { FC } from "react";
import { IngredientForm } from "~/app/_components/ingredients/ingredient-form";
import { LocationForm } from "~/app/_components/locations/location-form";
import { ProductForm } from "~/app/_components/products/product-form";
import { useTRPC } from "~/integrations/trpc/react";
import { EntityCreateWrapper } from "./entity-create-wrapper";

type NewEntityType = "product" | "ingredient" | "location";

interface NewEntityPageProps {
  entity: NewEntityType;
}

// Each form expects CreateModeProps from form-utils
// We use a render function pattern to pass the right props
const formRegistry: Record<
  NewEntityType,
  FC<{
    mode: "create";
    isPending: boolean;
    error: string | undefined;
    onCreate: (data: unknown) => void;
    onCancel: () => void;
  }>
> = {
  product: ProductForm as FC<{
    mode: "create";
    isPending: boolean;
    error: string | undefined;
    onCreate: (data: unknown) => void;
    onCancel: () => void;
  }>,
  ingredient: IngredientForm as FC<{
    mode: "create";
    isPending: boolean;
    error: string | undefined;
    onCreate: (data: unknown) => void;
    onCancel: () => void;
  }>,
  location: LocationForm as FC<{
    mode: "create";
    isPending: boolean;
    error: string | undefined;
    onCreate: (data: unknown) => void;
    onCancel: () => void;
  }>,
};

/**
 * Generic "Create New Entity" page component.
 * Consolidates the repeated pattern of EntityCreateWrapper + Form.
 */
export function NewEntityPage({ entity }: NewEntityPageProps) {
  const api = useTRPC();

  // Get the correct mutation options based on entity type
  const mutationOptions = {
    product: api.product.create.mutationOptions(),
    ingredient: api.ingredient.create.mutationOptions(),
    location: api.location.create.mutationOptions(),
  }[entity];

  const Form = formRegistry[entity];

  return (
    <EntityCreateWrapper entity={entity} mutationOptions={mutationOptions}>
      {({ isPending, error, onCreate, onCreateAsync, onCancel }) => (
        <Form
          mode="create"
          isPending={isPending}
          error={error}
          // Location form uses onCreateAsync, others use onCreate
          onCreate={entity === "location" ? onCreateAsync : onCreate}
          onCancel={onCancel}
        />
      )}
    </EntityCreateWrapper>
  );
}
