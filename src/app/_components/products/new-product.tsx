"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ProductForm, type CreateProductData } from "./product-form";
import { api } from "~/trpc/react";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";

export function NewProduct() {
  const router = useRouter();
  const [error, setError] = useState<string | undefined>();

  const createProduct = api.product.create.useMutation({
    onSuccess: (product) => {
      router.push(`/products/${product.id}`);
    },
    onError: (error) => {
      setError(error.message);
    },
  });

  const handleCreate = (data: CreateProductData) => {
    createProduct.mutate(data);
  };

  const handleCancel = () => {
    router.push("/products");
  };

  return (
    <div className="container mx-auto py-10">
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
    </div>
  );
}
