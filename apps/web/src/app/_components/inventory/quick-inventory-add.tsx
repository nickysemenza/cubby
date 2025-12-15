"use client";

import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useTRPC } from "~/trpc/react";
import { Button } from "~/components/ui/button";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import { type ProductId, type LocationId } from "~/schemas/identifiers";
import { useMutation } from "@tanstack/react-query";
import { ComboboxFieldWithSearch } from "~/app/_components/form-utils";
import { ComboboxItem } from "../combobox/combobox-types";
import { AmountFieldGroup } from "./amount-field-group";
import { Form } from "~/components/ui/form";
import { amount } from "~/codec/codec";

interface QuickInventoryAddProps {
  locationId: LocationId;
  onSuccess: () => void;
}

const formSchema = z.object({
  product: ComboboxItem.refine((item) => item !== null, {
    message: "Please select a product",
  }),
  amount: amount,
});

type FormValues = z.infer<typeof formSchema>;

export function QuickInventoryAdd({
  locationId,
  onSuccess,
}: QuickInventoryAddProps) {
  const api = useTRPC();

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      product: undefined,
      amount: { value: 1, unit: "" },
    },
  });

  const createMutation = useMutation(
    api.inventoryItem.create.mutationOptions({
      onSuccess: () => {
        toast.success("Item added to inventory");
        form.reset({ product: undefined, amount: { value: 1, unit: "" } });
        onSuccess();
      },
      onError: (err) => {
        toast.error(err.message || "Failed to add item");
      },
    }),
  );

  const onSubmit = async (values: FormValues) => {
    await createMutation.mutateAsync({
      productId: values.product!.id as ProductId,
      locationId,
      amount: values.amount,
    });
  };

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)}>
        <div className="flex items-end gap-2">
          <div className="min-w-[200px] flex-1">
            <ComboboxFieldWithSearch
              form={form}
              name="product"
              label="Add Product"
              searchType="product"
            />
          </div>
          <div className="flex-shrink-0">
            <AmountFieldGroup
              form={form}
              valuePath="amount.value"
              unitPath="amount.unit"
            />
          </div>
          <Button
            type="submit"
            size="icon"
            disabled={createMutation.isPending}
            className="mb-0.5 flex-shrink-0"
          >
            <Plus className="h-4 w-4" />
          </Button>
        </div>
      </form>
    </Form>
  );
}
