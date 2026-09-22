import type { MutationSideEffects } from "@cubby/schemas/background-jobs";
import { amount } from "@cubby/schemas/codec";
import type {
  LocationShortcode,
  ProductShortcode,
} from "@cubby/schemas/identifiers";
import {
  ingredientShortcode,
  productCategoryShortcode,
} from "@cubby/schemas/identifiers";
import { unitMappingInput } from "@cubby/schemas/unitmapping";
import { UNSPECIFIED_MANUFACTURER } from "@cubby/shared";
import { fdcId, upc } from "@cubby/usda-schemas";
import { zodResolver } from "@hookform/resolvers/zod";
import { ChevronDown, Plus, X } from "lucide-react";
import { useCallback, useState } from "react";
import { FormProvider, useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

import { FieldSuggestionProvider } from "~/app/_components/ai/field-suggestion-provider";
import {
  getOptionalProductShortcode,
  requiredProductField,
} from "~/app/_components/form-fields";
import {
  ComboboxField,
  NullableNumericField,
  UnifiedTextField,
} from "~/app/_components/form-utils";
import { useEntityActionMutation } from "~/app/_components/hooks/useActionMutation";
import { showErrorToast } from "~/components/feedback/error-details";
import { Row } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { Collapsible, CollapsibleContent } from "~/components/ui/collapsible";
import { Spinner } from "~/components/ui/spinner";
import { EntityIntentFields } from "~/entities/editing/entity-primitive-fields";
import { entityMutationOptionsFactory } from "~/entities/entity-contracts";
import { useImageState } from "~/hooks/useImageState";
import { getErrorMessage } from "~/lib/error-utils";
import { savedWithBackgroundWork } from "~/lib/recompute-summary";
import { cn } from "~/lib/utils";
import { wasm } from "~/lib/wasm";

import type { ComboboxItem } from "../combobox/combobox-types";
import { WithEntitySearch } from "../combobox/with-search-hook";
import { PendingImageUpload } from "../PendingImageUpload";
import { IdentifyProductButton } from "../products/identify-product-with-ai";
import { useUpcAwareCreate } from "../products/use-upc-aware-create";
import { AmountFieldGroup, DEFAULT_AMOUNT_UNIT } from "./amount-field-group";
import {
  useCreateInventoryMutation,
  useProductLookupInvalidation,
} from "./hooks";

/**
 * Client-side counterpart to the deleted `@cubby/schemas/isbn`'s `isbn` Zod
 * export — see `product-editor-fields.tsx`'s own doc comment for the reason
 * this lives with the form rather than `packages/schemas`. Only this
 * bespoke create form still needs it; the generic editor reads/writes
 * `primaryGtin` through `definitions.ts`'s `productIsbnInitial` instead.
 */
const isbnFormField = z
  .string()
  .trim()
  .transform((value, ctx) => {
    const normalized = wasm.normalize_isbn(value);
    if (!normalized) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "expected a valid ISBN-10 or ISBN-13",
      });
      return z.NEVER;
    }
    return normalized.gtin14;
  });

interface QuickInventoryAddProps {
  locationId: LocationShortcode;
  onSuccess: () => void;
  /**
   * Prefills the select-mode product picker (and restores it after each add) —
   * used when the surface already knows the product, e.g. a product page.
   */
  initialProduct?: ComboboxItem<ProductShortcode>;
  /**
   * Replaces the inventory-create transport for a local host (for example, an
   * embedded browser harness). The product picker, UPC resolution, and image
   * state remain their real browser modules.
   */
  operations?: QuickInventoryOperations;
}

export interface QuickInventoryOperations {
  createInventory: (input: {
    productId: ProductShortcode;
    locationId: LocationShortcode;
    amount: SelectFormValues["amount"];
  }) => Promise<void>;
}

const selectFormSchema = z.object({
  product: requiredProductField,
  amount: amount,
});
type SelectFormValues = z.input<typeof selectFormSchema>;

const createFormSchema = z
  .object({
    name: z.string().min(1, "Name is required"),
    manufacturer: z.string().min(1, "Manufacturer is required"),
    model: z.string().nullable(),
    notes: z.string().nullable(),
    // The picker owns a string draft; parse the shortcode at the Product
    // mutation boundary below, where malformed values become a field error.
    categoryId: z.string().nullable(),
    upc: upc.nullable(),
    isbn: isbnFormField.nullable(),
    fdc_id: fdcId.nullable(),
    expectedQuantity: z.number().int().positive().nullable(),
    price: z.number().positive().nullable(),
    // `EntityIntentFields`' generic reference picker writes the raw
    // shortcode string directly, unlike the retired `ComboboxItem`-typed
    // `ingredient` field.
    ingredientId: z.string().nullable(),
    unitMappings: z.array(unitMappingInput),
    amount: amount,
  })
  .transform((data) => ({
    ...data,
    upc: data.upc === "" ? null : data.upc,
    fdc_id: data.fdc_id === 0 ? null : data.fdc_id,
  }));
type CreateFormValues = z.input<typeof createFormSchema>;

export function QuickInventoryAdd({
  locationId,
  onSuccess,
  initialProduct,
  operations,
}: QuickInventoryAddProps) {
  const invalidateProductLookup = useProductLookupInvalidation();
  const [mode, setMode] = useState<"select" | "create">("select");
  const [fieldsExpanded, setFieldsExpanded] = useState(false);

  const imageState = useImageState();

  const selectForm = useForm<SelectFormValues>({
    resolver: zodResolver(selectFormSchema),
    defaultValues: {
      product: initialProduct,
      amount: { value: 1, unit: DEFAULT_AMOUNT_UNIT },
    },
  });

  const onInventoryAdded = useCallback(() => {
    toast.success("Tucked it into your cubby.");
    selectForm.reset({
      product: initialProduct,
      amount: { value: 1, unit: DEFAULT_AMOUNT_UNIT },
    });
    onSuccess();
  }, [initialProduct, onSuccess, selectForm]);

  const addMutation = useCreateInventoryMutation({
    onSuccess: onInventoryAdded,
  });

  const onSelectSubmit = async (values: SelectFormValues) => {
    const input = {
      productId: getOptionalProductShortcode(values.product)!,
      locationId,
      amount: values.amount,
    };
    if (operations) {
      try {
        await operations.createInventory(input);
        onInventoryAdded();
      } catch (error) {
        showErrorToast(error);
      }
      return;
    }
    await addMutation.mutateAsync(input);
  };

  const createForm = useForm<CreateFormValues>({
    resolver: zodResolver(createFormSchema),
    defaultValues: {
      name: "",
      manufacturer: UNSPECIFIED_MANUFACTURER,
      model: null,
      notes: null,
      categoryId: null,
      upc: null,
      isbn: null,
      fdc_id: null,
      expectedQuantity: null,
      price: null,
      ingredientId: null,
      unitMappings: [],
      amount: { value: 1, unit: DEFAULT_AMOUNT_UNIT },
    },
  });

  const productCreateMutation = useEntityActionMutation({
    entity: "product",
    operation: "create",
    mutationFn: entityMutationOptionsFactory("product", "create"),
    onSuccess: invalidateProductLookup,
    error: "Failed to create product",
  });
  const inventoryCreateMutation = useCreateInventoryMutation({
    // No toast here: the inner catch below already turns this mutation's
    // failure into one `showErrorToast` with the "product was created,
    // but..." context; a populated `onError` would additionally trigger the
    // global toast.
    onError: () => {},
  });

  const [isCreating, setIsCreating] = useState(false);

  const onCreateSubmit = async (values: CreateFormValues) => {
    setIsCreating(true);
    try {
      const newProduct = await productCreateMutation.mutateAsync({
        name: values.name,
        manufacturer: values.manufacturer,
        model: values.model,
        notes: values.notes,
        categoryId:
          values.categoryId == null
            ? null
            : productCategoryShortcode.parse(values.categoryId),
        upc: values.upc,
        isbn: values.isbn,
        fdc_id: values.fdc_id,
        expectedQuantity: values.expectedQuantity,
        price: values.price,
        ingredientId:
          values.ingredientId == null
            ? null
            : ingredientShortcode.parse(values.ingredientId),
        unitMappings: values.unitMappings,
        ...imageState.getImageData(true),
      });

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
        showErrorToast(
          inventoryErr,
          `Product "${newProduct.name}" was created, but adding to inventory failed: ${getErrorMessage(inventoryErr)}. Search for it to add manually.`,
        );
        invalidateProductLookup();
        switchToSelectMode();
      }
    } catch {
      // SILENT: already showErrorToast'd by productCreateMutation's own
      // onError (useEntityActionMutation); this only stops the rejection
      // from escaping the submit handler.
    } finally {
      setIsCreating(false);
    }
  };

  const handleCreateNew = useCallback(
    (name: string): Promise<ComboboxItem<ProductShortcode>> => {
      createForm.reset({
        name,
        manufacturer: UNSPECIFIED_MANUFACTURER,
        model: null,
        notes: null,
        categoryId: null,
        upc: null,
        isbn: null,
        fdc_id: null,
        expectedQuantity: null,
        price: null,
        ingredientId: null,
        unitMappings: [],
        amount: { value: 1, unit: DEFAULT_AMOUNT_UNIT },
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

  if (mode === "select") {
    return (
      <FormProvider {...selectForm}>
        <form onSubmit={selectForm.handleSubmit(onSelectSubmit)}>
          <div className="flex flex-col gap-2">
            <Row align="end" gap="sm">
              <div className="flex-1">
                <WithEntitySearch entity="product" intent="stock">
                  {({ items, onSearchChange, isLoading, onOpenChange }) => (
                    <ComboboxField
                      entity="product"
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
                </WithEntitySearch>
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
        <Row align="center" justify="between">
          <h4 className="text-sm font-medium">New Product</h4>
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
              "flex w-full items-center gap-1 text-xs text-muted-foreground hover:text-foreground",
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
              "data-[panel-open]:animate-in data-[panel-open]:fade-in-0",
            )}
          >
            <div className="space-y-4 pt-4">
              {/* `categoryId` renders with `suggestField="categoryId"` —
                  without a provider mounted here, `useAutoFieldSuggestion`
                  now reports it loudly in dev (see the discard-dialog gap
                  this guard exists to catch). */}
              <FieldSuggestionProvider
                entity="product"
                mode="create"
                fieldKeys={["categoryId"]}
              >
                <EntityIntentFields
                  entity="product"
                  intent="quickDetails"
                  mode="create"
                />
              </FieldSuggestionProvider>
              {/* Images stay hand-wired here (not the generic editor's
                  shell): this compact panel has no `pendingImageIds` in its
                  own roster, and `useImageState` already owns the create
                  form's pending-image lifecycle. */}
              <PendingImageUpload
                entityType="PRODUCT"
                onImagesChange={imageState.handlePendingImagesChange}
              />
              <IdentifyProductButton
                form={{
                  setValue: (update) =>
                    createForm.setValue(update.field, update.value, {
                      shouldDirty: true,
                    }),
                }}
                pendingImages={imageState.pendingImages}
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
