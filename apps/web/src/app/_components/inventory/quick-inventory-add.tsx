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

import type { MutationSideEffects } from "@cubby/schemas/background-jobs";
import { amount } from "@cubby/schemas/codec";
import type {
  LocationShortcode,
  ProductShortcode,
} from "@cubby/schemas/identifiers";
import { productCategory } from "@cubby/schemas/product";
import { unitMappingInput } from "@cubby/schemas/unitmapping";
import { UNSPECIFIED_MANUFACTURER } from "@cubby/shared";
import { fdcId, upc } from "@cubby/usda-schemas";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation } from "@tanstack/react-query";
import { ChevronDown, Plus, X } from "lucide-react";
import { useCallback, useState } from "react";
import { FormProvider, useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import {
  getOptionalIngredientId,
  getOptionalProductShortcode,
  optionalIngredientField,
  requiredProductField,
} from "~/app/_components/form-fields";
import {
  ComboboxField,
  NullableNumericField,
  UnifiedTextField,
} from "~/app/_components/form-utils";
import { Row } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { Collapsible, CollapsibleContent } from "~/components/ui/collapsible";
import { Spinner } from "~/components/ui/spinner";
import { useImageState } from "~/hooks/useImageState";
import { useTRPC } from "~/integrations/trpc/react";
import { getErrorMessage } from "~/lib/error-utils";
import { savedWithBackgroundWork } from "~/lib/recompute-summary";
import { cn } from "~/lib/utils";
import type { ComboboxItem } from "../combobox/combobox-types";
import { WithProductSearch } from "../combobox/with-search-hook";
import { ProductFormFields } from "../products/product-form-fields";
import { useUpcAwareCreate } from "../products/use-upc-aware-create";
import { AmountFieldGroup } from "./amount-field-group";
import {
  useCreateInventoryMutation,
  useProductLookupInvalidation,
} from "./hooks";

interface QuickInventoryAddProps {
  locationId: LocationShortcode;
  onSuccess: () => void;
  /**
   * Prefills the select-mode product picker (and restores it after each add) —
   * used when the surface already knows the product, e.g. a product page.
   */
  initialProduct?: ComboboxItem<ProductShortcode>;
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
    fdc_id: fdcId.nullable(),
    expectedQuantity: z.number().int().positive().nullable(),
    price: z.number().positive().nullable(),
    ingredient: optionalIngredientField,
    unitMappings: z.array(unitMappingInput),
    amount: amount,
  })
  .transform((data) => ({
    ...data,
    upc: data.upc === "" ? null : data.upc,
    fdc_id: data.fdc_id === 0 ? null : data.fdc_id,
  }));
type CreateFormValues = z.infer<typeof createFormSchema>;

export function QuickInventoryAdd({
  locationId,
  onSuccess,
  initialProduct,
}: QuickInventoryAddProps) {
  const api = useTRPC();
  const invalidateProductLookup = useProductLookupInvalidation();
  const [mode, setMode] = useState<"select" | "create">("select");
  const [fieldsExpanded, setFieldsExpanded] = useState(false);

  const imageState = useImageState();

  // --- Select mode form ---
  const selectForm = useForm<SelectFormValues>({
    resolver: zodResolver(selectFormSchema),
    defaultValues: {
      product: initialProduct,
      amount: { value: 1, unit: "" },
    },
  });

  const addMutation = useCreateInventoryMutation({
    onSuccess: () => {
      toast.success("Tucked it into your cubby.");
      selectForm.reset({
        product: initialProduct,
        amount: { value: 1, unit: "" },
      });
      onSuccess();
    },
    onError: (err) => toast.error(getErrorMessage(err) || "Failed to add item"),
  });

  const onSelectSubmit = async (values: SelectFormValues) => {
    await addMutation.mutateAsync({
      productId: getOptionalProductShortcode(values.product)!,
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
      fdc_id: null,
      expectedQuantity: null,
      price: null,
      ingredient: null,
      unitMappings: [],
      amount: { value: 1, unit: "" },
    },
  });

  const productCreateMutation = useMutation(
    api.product.create.mutationOptions({ onSuccess: invalidateProductLookup }),
  );
  const inventoryCreateMutation = useCreateInventoryMutation();

  const [isCreating, setIsCreating] = useState(false);

  const onCreateSubmit = async (values: CreateFormValues) => {
    setIsCreating(true);
    try {
      // Step 1: Create the product
      const newProduct = await productCreateMutation.mutateAsync({
        name: values.name,
        manufacturer: values.manufacturer,
        model: values.model,
        notes: values.notes,
        category: values.category,
        upc: values.upc,
        fdc_id: values.fdc_id,
        expectedQuantity: values.expectedQuantity,
        price: values.price,
        ingredientId: getOptionalIngredientId(values.ingredient) ?? null,
        unitMappings: values.unitMappings,
        ...imageState.getImageData(true),
      });

      // Step 2: Create the inventory entry
      try {
        const inventory = await inventoryCreateMutation.mutateAsync({
          productId: newProduct.id,
          locationId,
          amount: values.amount,
        });

        const sideEffects: MutationSideEffects = {
          backgroundBatches: [
            ...newProduct.sideEffects.backgroundBatches,
            ...inventory.sideEffects.backgroundBatches,
          ],
        };
        toast.success(
          savedWithBackgroundWork(
            sideEffects,
            `Created "${newProduct.name}" and added to inventory`,
          ),
        );
        switchToSelectMode();
        onSuccess();
      } catch (inventoryErr) {
        // Product created but inventory failed
        toast.error(
          `Product "${newProduct.name}" was created, but adding to inventory failed: ${getErrorMessage(inventoryErr)}. Search for it to add manually.`,
        );
        invalidateProductLookup();
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
    (name: string): Promise<ComboboxItem<ProductShortcode>> => {
      createForm.reset({
        name,
        manufacturer: UNSPECIFIED_MANUFACTURER,
        model: null,
        notes: null,
        category: null,
        upc: null,
        fdc_id: null,
        expectedQuantity: null,
        price: null,
        ingredient: null,
        unitMappings: [],
        amount: { value: 1, unit: "" },
      });
      imageState.reset();
      setMode("create");
      // Return a never-resolving promise — the combobox will unmount before it matters
      return new Promise<ComboboxItem<ProductShortcode>>(() => {});
    },
    [createForm, imageState],
  );
  // A pasted UPC creates + selects inline (via the lookup cascade) without
  // switching to the full create form; a plain name still opens create mode.
  const onCreateNew = useUpcAwareCreate(handleCreateNew);

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
            <Row align="end" gap="sm">
              <div className="flex-1">
                <WithProductSearch>
                  {({ items, onSearchChange, isLoading, onOpenChange }) => (
                    <ComboboxField
                      form={selectForm}
                      name="product"
                      label="Add Product"
                      items={items}
                      onSearchChange={onSearchChange}
                      isLoading={isLoading}
                      onCreateNew={onCreateNew}
                      onOpenChange={onOpenChange}
                    />
                  )}
                </WithProductSearch>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => handleCreateNew("")}
                className="mb-1"
              >
                <Plus className="mr-1 size-3" />
                New
              </Button>
            </Row>
            <Row align="end" gap="sm">
              <AmountFieldGroup
                form={selectForm}
                valuePath="amount.value"
                unitPath="amount.unit"
              />
              <Button
                type="submit"
                size="icon"
                disabled={addMutation.isPending}
                className="mb-1"
              >
                <Plus className="size-4" />
              </Button>
            </Row>
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
        className="space-y-4"
      >
        {/* Header */}
        <Row align="center" justify="between">
          <h4 className="font-medium text-sm">New Product</h4>
          <Button
            type="button"
            variant="ghost"
            size="default"
            onClick={switchToSelectMode}
          >
            <X className="mr-1 size-3" />
            Cancel
          </Button>
        </Row>

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
                "size-3 transition-transform",
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
            <div className="pt-4">
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
        <Row align="end" gap="sm">
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
            className="mb-1"
          >
            {isCreating ? (
              <Spinner size="sm" />
            ) : (
              <Plus className="mr-1 size-3" />
            )}
            Create & Add
          </Button>
        </Row>
      </form>
    </FormProvider>
  );
}
