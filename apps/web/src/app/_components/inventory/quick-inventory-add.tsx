/**
 * QuickInventoryAdd - Compact inline form for adding inventory items to a location.
 *
 * Two modes:
 * - **Select**: Pick an existing product from combobox + amount (default)
 * - **Create**: Full inline product creation + amount, expanded with animation
 *
 * When the user clicks "create new" in the combobox dropdown, the form switches
 * to create mode, expanding product fields inline using the Collapsible component.
 */

import { amount } from "@cubby/schemas/codec";
import type { LocationId } from "@cubby/schemas/identifiers";
import { productCategory } from "@cubby/schemas/product";
import { unitMappingInput } from "@cubby/schemas/unitmapping";
import { UNSPECIFIED_MANUFACTURER } from "@cubby/shared";
import { ndb, upc } from "@cubby/usda-schemas";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Plus, X } from "lucide-react";
import { useCallback, useState } from "react";
import { FormProvider, useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import {
  getOptionalIngredientId,
  getOptionalProductId,
  requiredProductField,
} from "~/app/_components/form-fields";
import {
  ComboboxField,
  NullableNumericField,
  UnifiedTextField,
} from "~/app/_components/form-utils";
import { useActionMutation } from "~/app/_components/hooks/useActionMutation";
import { Button } from "~/components/ui/button";
import { Collapsible, CollapsibleContent } from "~/components/ui/collapsible";
import { Spinner } from "~/components/ui/spinner";
import { useImageState } from "~/hooks/useImageState";
import { getErrorMessage } from "~/lib/error-utils";
import { queryKeys } from "~/lib/query-keys";
import { cn } from "~/lib/utils";
import { useTRPC } from "~/trpc/react";
import { ComboboxItem } from "../combobox/combobox-types";
import { ProductFormFields } from "../products/product-form-fields";
import { useProductSearch } from "../products/use-product-search";
import { AmountFieldGroup } from "./amount-field-group";

interface QuickInventoryAddProps {
  locationId: LocationId;
  onSuccess: () => void;
}

// Schema for select mode (existing product)
const selectFormSchema = z.object({
  product: requiredProductField,
  amount: amount,
});
type SelectFormValues = z.input<typeof selectFormSchema>;

// Schema for create mode (new product + inventory amount)
const createFormSchema = z
  .object({
    name: z.string().min(1, "Name is required"),
    manufacturer: z.string().min(1, "Manufacturer is required"),
    model: z.string().nullable(),
    notes: z.string().nullable(),
    category: productCategory.nullable(),
    upc: upc.nullable(),
    ndb_number: ndb.nullable(),
    expectedQuantity: z.number().int().positive().nullable(),
    price: z.number().positive().nullable(),
    ingredient: ComboboxItem.nullable(),
    unitMappings: z.array(unitMappingInput),
    amount: amount,
  })
  .transform((data) => ({
    ...data,
    upc: data.upc === "" ? null : data.upc,
    ndb_number: data.ndb_number === 0 ? null : data.ndb_number,
  }));
type CreateFormValues = z.infer<typeof createFormSchema>;

export function QuickInventoryAdd({
  locationId,
  onSuccess,
}: QuickInventoryAddProps) {
  const api = useTRPC();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<"select" | "create">("select");
  const [fieldsExpanded, setFieldsExpanded] = useState(false);

  const imageState = useImageState();

  // Product search for the combobox in select mode
  const productSearch = useProductSearch();

  // --- Select mode form ---
  const selectForm = useForm<SelectFormValues>({
    resolver: zodResolver(selectFormSchema),
    defaultValues: {
      product: undefined,
      amount: { value: 1, unit: "" },
    },
  });

  const addMutation = useActionMutation({
    mutationFn: api.inventory.create.mutationOptions,
    success: "Tucked it into your cubby.",
    onSuccess: () => {
      selectForm.reset({
        product: undefined,
        amount: { value: 1, unit: "" },
      });
      onSuccess();
    },
    error: (err) => getErrorMessage(err) || "Failed to add item",
  });

  const onSelectSubmit = async (values: SelectFormValues) => {
    await addMutation.mutateAsync({
      productId: getOptionalProductId(values.product)!,
      locationId,
      amount: values.amount,
    });
  };

  // --- Create mode form ---
  const createForm = useForm<CreateFormValues>({
    resolver: zodResolver(createFormSchema),
    defaultValues: {
      name: "",
      manufacturer: UNSPECIFIED_MANUFACTURER,
      model: null,
      notes: null,
      category: null,
      upc: null,
      ndb_number: null,
      expectedQuantity: null,
      price: null,
      ingredient: null,
      unitMappings: [],
      amount: { value: 1, unit: "" },
    },
  });

  const productCreateMutation = useMutation(
    api.product.create.mutationOptions(),
  );
  const inventoryCreateMutation = useMutation(
    api.inventory.create.mutationOptions(),
  );

  const [isCreating, setIsCreating] = useState(false);

  const onCreateSubmit = async (values: CreateFormValues) => {
    setIsCreating(true);
    try {
      // Step 1: Create the product
      const newProduct = await productCreateMutation.mutateAsync({
        name: values.name,
        manufacturer: values.manufacturer,
        model: values.model,
        category: values.category,
        upc: values.upc,
        ndb_number: values.ndb_number,
        fdc_id: null,
        expectedQuantity: values.expectedQuantity,
        price: values.price,
        ingredientId: getOptionalIngredientId(values.ingredient) ?? null,
        unitMappings: values.unitMappings,
        ...imageState.getImageData(true),
      });

      // Step 2: Create the inventory entry
      try {
        await inventoryCreateMutation.mutateAsync({
          productId: newProduct.id,
          locationId,
          amount: values.amount,
        });

        toast.success(`Created "${newProduct.name}" and added to inventory`);
        void queryClient.invalidateQueries({
          queryKey: [queryKeys.product.list],
        });
        switchToSelectMode();
        onSuccess();
      } catch (inventoryErr) {
        // Product created but inventory failed
        toast.error(
          `Product "${newProduct.name}" was created, but adding to inventory failed: ${getErrorMessage(inventoryErr)}. Search for it to add manually.`,
        );
        void queryClient.invalidateQueries({
          queryKey: [queryKeys.product.list],
        });
        switchToSelectMode();
      }
    } catch (productErr) {
      toast.error(`Failed to create product: ${getErrorMessage(productErr)}`);
      // Stay in create mode so the user can fix and retry
    } finally {
      setIsCreating(false);
    }
  };

  // Switch to create mode with initial product name from search text
  const handleCreateNew = useCallback(
    (name: string): Promise<ComboboxItem> => {
      createForm.reset({
        name,
        manufacturer: UNSPECIFIED_MANUFACTURER,
        model: null,
        notes: null,
        category: null,
        upc: null,
        ndb_number: null,
        expectedQuantity: null,
        price: null,
        ingredient: null,
        unitMappings: [],
        amount: { value: 1, unit: "" },
      });
      imageState.reset();
      setMode("create");
      // Return a never-resolving promise — the combobox will unmount before it matters
      return new Promise<ComboboxItem>(() => {});
    },
    [createForm, imageState],
  );

  const switchToSelectMode = useCallback(() => {
    setFieldsExpanded(false);
    setMode("select");
    createForm.reset();
    imageState.reset();
  }, [createForm, imageState]);

  // --- Select mode ---
  if (mode === "select") {
    return (
      <FormProvider {...selectForm}>
        <form onSubmit={selectForm.handleSubmit(onSelectSubmit)}>
          <div className="flex flex-col gap-2">
            <div className="flex items-end gap-2">
              <div className="flex-1">
                <ComboboxField
                  form={selectForm}
                  name="product"
                  label="Add Product"
                  items={productSearch.items}
                  onSearchChange={productSearch.onSearchChange}
                  isLoading={productSearch.isLoading}
                  onCreateNew={handleCreateNew}
                />
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => handleCreateNew("")}
                className="mb-0.5"
              >
                <Plus className="mr-1 h-3 w-3" />
                New
              </Button>
            </div>
            <div className="flex items-end gap-2">
              <AmountFieldGroup
                form={selectForm}
                valuePath="amount.value"
                unitPath="amount.unit"
              />
              <Button
                type="submit"
                size="icon"
                disabled={addMutation.isPending}
                className="mb-0.5"
              >
                <Plus className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </form>
      </FormProvider>
    );
  }

  // --- Create mode ---
  return (
    <FormProvider {...createForm}>
      <form
        onSubmit={(e) => {
          e.stopPropagation();
          e.preventDefault();
          createForm.handleSubmit(onCreateSubmit)(e);
        }}
        className="space-y-3"
      >
        {/* Header */}
        <div className="flex items-center justify-between">
          <h4 className="font-medium text-sm">New Product</h4>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={switchToSelectMode}
            className="h-7 px-2"
          >
            <X className="mr-1 h-3 w-3" />
            Cancel
          </Button>
        </div>

        {/* Product name — always visible */}
        <UnifiedTextField
          form={createForm}
          name="name"
          label="Product Name"
          placeholder="Enter product name"
          nullable={false}
        />

        {/* Expandable product details */}
        <Collapsible open={fieldsExpanded} onOpenChange={setFieldsExpanded}>
          <button
            type="button"
            onClick={() => setFieldsExpanded((prev) => !prev)}
            className={cn(
              "flex w-full items-center gap-1 text-muted-foreground text-xs hover:text-foreground",
              "transition-colors",
            )}
          >
            <ChevronDown
              className={cn(
                "h-3 w-3 transition-transform",
                fieldsExpanded && "rotate-180",
              )}
            />
            {fieldsExpanded ? "Hide" : "Show"} product details
          </button>
          <CollapsibleContent
            className={cn(
              "overflow-hidden",
              "transition-all duration-200 ease-out",
              "data-[panel-open]:fade-in-0 data-[panel-open]:animate-in",
            )}
          >
            <div className="pt-3">
              <ProductFormFields
                form={createForm}
                imageHandlers={imageState}
                hideNameField
                hidePrice
                compact
              />
            </div>
          </CollapsibleContent>
        </Collapsible>

        {/* Price + Amount + submit */}
        <div className="flex items-end gap-2">
          <div className="w-28">
            <NullableNumericField
              form={createForm}
              step="0.01"
              name="price"
              label="Price"
              placeholder="e.g. 5.99"
              prefix="$"
            />
          </div>
          <AmountFieldGroup
            form={createForm}
            valuePath="amount.value"
            unitPath="amount.unit"
          />
          <Button
            type="submit"
            size="sm"
            disabled={isCreating}
            className="mb-0.5"
          >
            {isCreating ? (
              <Spinner size="sm" />
            ) : (
              <Plus className="mr-1 h-3 w-3" />
            )}
            Create & Add
          </Button>
        </div>
      </form>
    </FormProvider>
  );
}
