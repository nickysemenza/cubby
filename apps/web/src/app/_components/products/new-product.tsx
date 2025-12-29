import { EntityCreateWrapper } from "~/components/entity/entity-create-wrapper";
import type { ProductInputPayload } from "~/schemas/product";
import { useTRPC } from "~/trpc/react";
import { ProductForm } from "./product-form";

export function NewProduct() {
  const api = useTRPC();

  return (
    <EntityCreateWrapper<ProductInputPayload, { id: string }>
      entity="product"
      mutationOptions={api.product.create.mutationOptions()}
    >
      {({ isPending, error, onCreate, onCancel }) => (
        <ProductForm
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
