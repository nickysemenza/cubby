"use client";

import { useWasm } from "~/wasmContext";
import { type FC } from "react";
import { Input } from "~/components/ui/input";
import { Button } from "~/components/ui/button";
import { Amount } from "~/codec/codec";
import { api } from "~/trpc/react";
import {
  clientSideFilter,
  Combobox,
  ComboboxItem,
} from "~/app/_components/combobox";
import { useRouter } from "next/navigation";
import {
  buildProductComboboxItem,
  buildLocationComboboxItem,
} from "~/app/_components/combobox/utils";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "~/components/ui/form";

const formSchema = z.object({
  product: ComboboxItem.refine((item) => item !== null, {
    message: "Please select a product",
  }),
  location: ComboboxItem.refine((item) => item !== null, {
    message: "Please select a location",
  }),
  amountValue: z.string().min(1, "Please enter a value"),
  amountUnit: z.string().min(1, "Please enter a unit"),
});

type FormValues = z.infer<typeof formSchema>;

const CreateInventoryItem: FC = () => {
  const { w } = useWasm();
  const router = useRouter();

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      product: undefined,
      location: undefined,
      amountValue: "",
      amountUnit: "",
    },
  });

  // Fetch locations and products for dropdowns
  const [locations] = api.location.list.useSuspenseQuery({
    pagination: { pageIndex: 0, pageSize: 100 },
    sort: { orderBy: "name", direction: "asc" },
  });
  const findLocations = async (searchQuery: string) =>
    clientSideFilter(
      locations.items.map(buildLocationComboboxItem),
      searchQuery,
    );

  const [products] = api.product.list.useSuspenseQuery({
    pagination: { pageIndex: 0, pageSize: 100 },
    sort: { orderBy: "name", direction: "asc" },
  });

  const findProducts = async (searchQuery: string): Promise<ComboboxItem[]> =>
    clientSideFilter(products.items.map(buildProductComboboxItem), searchQuery);

  const createMutation = api.inventoryItem.create.useMutation({
    onSuccess: (data) => {
      // Redirect to the new inventory item's detail page
      router.push(`/inventory/${data.id}`);
    },
    onError: (error) => {
      form.setError("root", { message: error.message });
    },
  });

  const onSubmit = (values: FormValues) => {
    const amount: Amount = {
      value: parseFloat(values.amountValue),
      unit: values.amountUnit,
    };

    createMutation.mutate({
      productId: values.product!.id,
      locationId: values.location!.id,
      amount,
    });
  };

  if (!w) {
    return <div>Loading...</div>;
  }

  return (
    <div className="container mx-auto p-4">
      <h1 className="mb-6 text-2xl font-bold">Create New Inventory Item</h1>

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
          <FormField
            control={form.control}
            name="product"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Product</FormLabel>
                <FormControl>
                  <Combobox
                    label="product"
                    findItems={findProducts}
                    value={field.value}
                    setValue={field.onChange}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="location"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Location</FormLabel>
                <FormControl>
                  <Combobox
                    label="location"
                    findItems={findLocations}
                    value={field.value}
                    setValue={field.onChange}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <div className="flex space-x-4">
            <FormField
              control={form.control}
              name="amountValue"
              render={({ field }) => (
                <FormItem className="flex-1">
                  <FormLabel>Amount Value</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      step="0.01"
                      placeholder="Enter amount"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="amountUnit"
              render={({ field }) => (
                <FormItem className="flex-1">
                  <FormLabel>Amount Unit</FormLabel>
                  <FormControl>
                    <Input type="text" placeholder="Enter unit" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>

          {form.formState.errors.root && (
            <div className="text-sm text-red-500">
              {form.formState.errors.root.message}
            </div>
          )}

          <div className="flex space-x-2">
            <Button type="submit" disabled={createMutation.isPending}>
              {createMutation.isPending ? "Creating..." : "Create"}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => router.back()}
              disabled={createMutation.isPending}
            >
              Cancel
            </Button>
          </div>
        </form>
      </Form>
    </div>
  );
};

export default CreateInventoryItem;
