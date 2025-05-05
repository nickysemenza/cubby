"use client";

import { useWasm } from "~/wasmContext";
import { type FC, useState } from "react";
import {
  InventoryForm,
  type CreateInventoryData,
} from "~/app/_components/inventory/inventory-form";
import { api } from "~/trpc/react";
import { useRouter } from "next/navigation";

const CreateInventoryItem: FC = () => {
  const { w } = useWasm();
  const router = useRouter();
  const [error, setError] = useState<string | undefined>();

  const createMutation = api.inventoryItem.create.useMutation({
    onSuccess: (data) => {
      // Redirect to the new inventory item's detail page
      router.push(`/inventory/${data.id}`);
    },
    onError: (error) => {
      setError(error.message);
    },
  });

  const handleCreate = (data: CreateInventoryData) => {
    createMutation.mutate(data);
  };

  if (!w) {
    return <div>Loading...</div>;
  }

  return (
    <div className="container mx-auto p-4">
      <h1 className="mb-6 text-2xl font-bold">Create New Inventory Item</h1>
      <InventoryForm
        mode="create"
        onCreate={handleCreate}
        isPending={createMutation.isPending}
        error={error}
        onCancel={() => router.back()}
      />
    </div>
  );
};

export default CreateInventoryItem;
