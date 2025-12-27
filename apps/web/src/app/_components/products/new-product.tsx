"use client";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import type { ProductInputPayload } from "~/schemas/product";
import { useTRPC } from "~/trpc/react";
import { useEntityCreateMode } from "../hooks/useEntityMode";
import { ProductForm } from "./product-form";

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
