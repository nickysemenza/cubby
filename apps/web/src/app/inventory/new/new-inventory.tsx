"use client";
import { type FC, useState } from "react";
import { InventoryForm } from "~/app/_components/inventory/inventory-form";
import { z } from "zod";
import { inventoryCreatePayloadData } from "~/schemas/inventory";
import { useTRPC } from "~/trpc/react";
import { useRouter } from "next/navigation";
import { entities } from "~/entities/entities";

import { useMutation } from "@tanstack/react-query";

const CreateInventoryItem: FC = () => {
  const api = useTRPC();
  const router = useRouter();
  const [error, setError] = useState<string | undefined>();

  const createMutation = useMutation(
    api.inventoryItem.create.mutationOptions({
      onSuccess: (data) => {
        // Redirect to the new inventory item's detail page
        router.push(`/${entities["inventory-item"].basePath}/${data.id}`);
      },
      onError: (error) => {
        setError(error.message);
      },
    }),
  );

  const handleCreate = (data: z.infer<typeof inventoryCreatePayloadData>) => {
    createMutation.mutate(data);
  };

  // We know w is always defined now with our updated useWasm hook

  return (
    <div>
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
