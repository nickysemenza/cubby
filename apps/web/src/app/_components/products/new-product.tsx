"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { ProductForm } from "./product-form";
import { type ProductInputPayload } from "~/schemas/product";
import { useTRPC } from "~/trpc/react";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { entities } from "~/entities/entities";

import { useMutation } from "@tanstack/react-query";

export function NewProduct() {
  const api = useTRPC();
  const router = useRouter();
  const [error, setError] = useState<string | undefined>();

  const createProduct = useMutation(
    api.product.create.mutationOptions({
      onSuccess: (product) => {
        router.push(`/${entities.product.basePath}/${product.id}`);
      },
      onError: (error) => {
        setError(error.message);
      },
    }),
  );

  const handleCreate = (data: ProductInputPayload) => {
    createProduct.mutate(data);
  };

  const handleCancel = () => {
    router.push(`/${entities.product.basePath}`);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Create New Product</CardTitle>
      </CardHeader>
      <CardContent>
        <ProductForm
          mode="create"
          isPending={createProduct.isPending}
          error={error}
          onCreate={handleCreate}
          onCancel={handleCancel}
        />
      </CardContent>
    </Card>
  );
}
