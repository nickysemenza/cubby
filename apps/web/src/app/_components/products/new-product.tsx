"use client";
import { ProductForm } from "./product-form";
import { type ProductInputPayload } from "~/schemas/product";
import { useTRPC } from "~/trpc/react";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { useEntityCreateMode } from "../hooks/useEntityMode";

export function NewProduct() {
  const api = useTRPC();

  const { error, isPending, handleCreate, handleCancel } = useEntityCreateMode<
    ProductInputPayload,
    { id: string }
  >("product", api.product.create.mutationOptions());

  return (
    <Card>
      <CardHeader>
        <CardTitle>Create New Product</CardTitle>
      </CardHeader>
      <CardContent>
        <ProductForm
          mode="create"
          isPending={isPending}
          error={error}
          onCreate={handleCreate}
          onCancel={handleCancel}
        />
      </CardContent>
    </Card>
  );
}
