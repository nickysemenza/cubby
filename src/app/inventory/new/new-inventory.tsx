"use client";
import { useWasm } from "~/wasmContext";
import { type FC, useState } from "react";
import { InventoryForm } from "~/app/_components/inventory/inventory-form";
import { z } from "zod";
import { inventoryCreatePayloadData } from "~/schemas/inventory";
import { useTRPC } from "~/trpc/react";
import { useRouter } from "next/navigation";

import { useMutation } from "@tanstack/react-query";

const CreateInventoryItem: FC = () => {
  const api = useTRPC();
  const { w } = useWasm();
  const router = useRouter();
  const [error, setError] = useState<string | undefined>();

  const createMutation = useMutation(
    api.inventoryItem.create.mutationOptions({
      onSuccess: (data) => {
        // Redirect to the new inventory item's detail page
        router.push(`/inventory/${data.id}`);
      },
      onError: (error) => {
        setError(error.message);
      },
    }),
  );

  const handleCreate = (data: z.infer<typeof inventoryCreatePayloadData>) => {
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
