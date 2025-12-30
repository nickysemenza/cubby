import { zodResolver } from "@hookform/resolvers/zod";
import { ndb, upc } from "@recipehub/usda-schemas";
import { Loader2, Search } from "lucide-react";
import { type FC, useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { ArrayFieldManager } from "~/components/forms/array-field-manager";
import { Button } from "~/components/ui/button";
import { Image } from "~/components/ui/image";
import { useImageState } from "~/hooks/useImageState";
import { isMiscProduct, UNSPECIFIED_MANUFACTURER } from "~/lib/constants";
import { getOptionalIngredientId } from "~/schemas/form-fields";
import type { IngredientId } from "~/schemas/identifiers";
import type { ImageOut } from "~/schemas/image";
import {
  extractPriceFromMappings,
  syncPriceToMappings,
} from "~/schemas/price-mapping-utils";
import {
  hasFoodIndicators,
  type ProductInputPayload,
  type ProductTopLevelOut,
  productCategory,
} from "~/schemas/product";
import { type UnitMappingInput, unitMappingInput } from "~/schemas/unitmapping";
import { useTRPCClient } from "~/trpc/react";
import { ComboboxItem } from "../combobox/combobox-types";
import {
  buildUpdateObject,
  ComboboxFieldWithSearch,
  type CreateModeProps,
  detectComboboxIdChange,
  type EditModeProps,
  FormWrapper,
  getSubmitButtonText,
  NullableNumericField,
  SelectField,
  SideBySideFields,
  UnifiedTextField,
} from "../form-utils";
import { AmountFieldGroup } from "../inventory/amount-field-group";
import { type PendingImage, PendingImageUpload } from "../PendingImageUpload";
import { productCategoryOptionsWithTheme } from "./product-category-icons";

// Form schema for product form (simple Zod schema without z.custom)
const formSchema = z
  .object({
    name: z.string().min(1, "Name is required"),
    manufacturer: z.string().min(1, "Manufacturer is required"),
    model: z.string().nullable(),
    category: productCategory.nullable(),
    upc: upc.nullable(), // Allow empty string and transform to null
    ndb_number: ndb.nullable(), // Allow empty string and transform to null
    expectedQuantity: z.number().int().positive().nullable(),
    price: z.number().positive().nullable(), // Shortcut for 1 each → $X mapping
    ingredient: ComboboxItem.nullable(), // Ingredient association
    unitMappings: z.array(unitMappingInput),
  })
  .transform((data) => ({
    ...data,
    upc: data.upc === "" ? null : data.upc,
    ndb_number: data.ndb_number === 0 ? null : data.ndb_number,
  }));

type ProductFormValues = z.infer<typeof formSchema>;

// Props for create mode
interface CreateProductFormProps extends CreateModeProps<ProductInputPayload> {
  product?: never;
  initialName?: string;
  initialExpectedQuantity?: number | null;
}

// Define a custom type for product with ingredient and unit mappings
interface ProductWithIngredient extends Omit<ProductTopLevelOut, "images"> {
  ingredient?: {
    id: string;
    name: string;
  } | null;
  unitMappings: UnitMappingInput[];
  images?: PendingImage[] | ImageOut[];
}

// Props for edit mode
interface EditProductFormProps
  extends EditModeProps<
    {
      id: string;
      data: Partial<ProductInputPayload>;
    },
    ProductWithIngredient
  > {
  entity: ProductWithIngredient;
}

// Combined props type using discriminated union
type ProductFormProps = CreateProductFormProps | EditProductFormProps;

export const ProductForm: FC<ProductFormProps> = (props) => {
  const { mode, isPending, error, onCancel } = props;
  const {
    handlePendingImagesChange,
    handleRemovedImagesChange,
    getImageData,
    hasImageChanges,
  } = useImageState();

  // UPC lookup state
  const [lookupImageUrl, setLookupImageUrl] = useState<string | null>(null);
  const [isLookingUp, setIsLookingUp] = useState(false);
  const trpcClient = useTRPCClient();

  // Get the product entity in edit mode
  const product = mode === "edit" ? props.entity : undefined;
  const initialName = mode === "create" ? props.initialName : undefined;
  const initialExpectedQuantity =
    mode === "create" ? props.initialExpectedQuantity : undefined;

  // Initialize form with default values or existing product data
  const form = useForm<ProductFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: product ? product.name : (initialName ?? ""),
      manufacturer: product ? product.manufacturer : UNSPECIFIED_MANUFACTURER,
      model: product ? product.model : null,
      category: product?.category ?? null,
      upc: product ? product.upc : null,
      ndb_number: product ? product.ndb_number : null,
      expectedQuantity: product
        ? product.expectedQuantity
        : (initialExpectedQuantity ?? null),
      price: null, // Will be set async in useEffect
      ingredient: product?.ingredient || null,
      unitMappings: product?.unitMappings ?? [],
    },
  });

  // Extract price from mappings
  useEffect(() => {
    const priceAmount = extractPriceFromMappings(product?.unitMappings ?? []);
    form.setValue("price", priceAmount?.value ?? null);
  }, [product?.unitMappings, form]);

  // Handle UPC lookup
  const handleUpcLookup = async () => {
    const upcValue = form.getValues("upc");
    if (!upcValue) return;

    setIsLookingUp(true);
    try {
      const result = await trpcClient.upc.lookup.query({ upc: upcValue });
      if (result) {
        // Auto-fill form fields from lookup result
        if (result.name) {
          form.setValue("name", result.name);
        }
        if (result.manufacturer) {
          form.setValue("manufacturer", result.manufacturer);
        } else if (result.brand) {
          form.setValue("manufacturer", result.brand);
        }
        if (result.priceDollars) {
          form.setValue("price", result.priceDollars);
        }
        // Store external image URL for display (read-only)
        if (result.imageUrl) {
          setLookupImageUrl(result.imageUrl);
        }
      }
    } catch (err) {
      console.error(`[Product Form] UPC lookup failed:`, err);
    } finally {
      setIsLookingUp(false);
    }
  };

  const handleSubmit = async (values: ProductFormValues) => {
    // Sync price field to unitMappings before saving
    // Form uses numeric price (assumes dollar), convert to Amount
    const unitMappingsWithPrice = syncPriceToMappings(
      values.unitMappings,
      values.price !== null ? { value: values.price, unit: "dollar" } : null,
      "product-form",
    );

    if (mode === "create") {
      // For creation, pass all fields
      const createData: ProductInputPayload = {
        name: values.name,
        manufacturer: values.manufacturer,
        model: values.model,
        category: values.category,
        upc: values.upc,
        ndb_number: values.ndb_number,
        expectedQuantity: values.expectedQuantity,
        ingredientId: getOptionalIngredientId(values.ingredient) ?? null,
        unitMappings: unitMappingsWithPrice,
        ...getImageData(true), // Apply pending images for creation
      };

      props.onCreate(createData);
    } else if (mode === "edit" && product) {
      // In edit mode, determine which fields have changed
      const updates: Partial<ProductInputPayload> = buildUpdateObject(
        {
          ...product,
        },
        values,
        [
          "name",
          "manufacturer",
          "model",
          "category",
          "upc",
          "ndb_number",
          "expectedQuantity",
        ],
      );

      // Check for ingredient changes
      const ingredientId = detectComboboxIdChange<IngredientId>(
        product.ingredient ? product.ingredient.id : null,
        values.ingredient,
      );

      if (ingredientId !== undefined) {
        updates.ingredientId = ingredientId;
      }

      // Check for unit mapping changes (including price sync)
      if (
        JSON.stringify(product.unitMappings) !==
        JSON.stringify(unitMappingsWithPrice)
      ) {
        updates.unitMappings = unitMappingsWithPrice;
      }

      // Check if we have any changes (field changes or image changes)
      const imageChanges = hasImageChanges();
      const hasFieldChanges = Object.keys(updates).length > 0;

      // Only update if there are changes
      if (hasFieldChanges || imageChanges) {
        const updateData = {
          id: product.id,
          data: {
            ...updates,
            ...getImageData(), // Apply image updates
          },
        };

        props.onEdit(updateData);
      } else if (onCancel) {
        // If no changes, just run the cancel function
        onCancel();
      }
    }
  };

  const buttonText = getSubmitButtonText(mode, isPending);

  // Watch the name field to detect misc products
  const nameValue = form.watch("name");
  const isMisc = isMiscProduct(nameValue);

  // Watch food indicator fields to determine if category should be forced to "food"
  const ndbValue = form.watch("ndb_number");
  const ingredientValue = form.watch("ingredient");
  const isFoodForced = hasFoodIndicators({
    ndb_number: ndbValue,
    ingredientId: ingredientValue?.id,
  });

  return (
    <FormWrapper
      form={form}
      onSubmit={handleSubmit}
      error={error}
      isPending={isPending}
      onCancel={onCancel}
      submitButtonText={buttonText}
    >
      {/* Start with model/name - primary identifiers for inventory */}
      <SideBySideFields>
        <UnifiedTextField
          form={form}
          name="model"
          label="Model Number"
          placeholder="Enter model number"
          nullable={true}
        />

        <UnifiedTextField
          form={form}
          name="name"
          label="Product Name"
          placeholder="Enter product name"
          nullable={false}
        />
      </SideBySideFields>

      {/* Hide manufacturer, pricing, UPC, NDB, ingredient for misc products */}
      {!isMisc && (
        <>
          <SideBySideFields>
            <UnifiedTextField
              form={form}
              name="manufacturer"
              label="Manufacturer"
              placeholder="Enter manufacturer"
              nullable={false}
            />
            <SelectField
              form={form}
              name="category"
              label="Category"
              options={productCategoryOptionsWithTheme}
              placeholder="Select category"
              nullable={true}
              disabled={isFoodForced}
              description={
                isFoodForced
                  ? "Forced to 'food' (has NDB number or ingredient)"
                  : undefined
              }
            />
          </SideBySideFields>

          {/* Inventory-specific fields */}
          <SideBySideFields>
            <NullableNumericField
              form={form}
              step="1"
              name="expectedQuantity"
              label="Expected Quantity (1 for unique items)"
              placeholder="Leave empty for unlimited"
            />
            <NullableNumericField
              form={form}
              step="0.01"
              name="price"
              label="Price per Item"
              placeholder="e.g. 12.99"
              prefix="$"
            />
          </SideBySideFields>

          {/* Secondary identifiers with UPC lookup */}
          <div className="space-y-2">
            <div className="flex items-end gap-2">
              <div className="flex-1">
                <UnifiedTextField
                  form={form}
                  name="upc"
                  label="UPC (Optional)"
                  placeholder="12-digit UPC code"
                  nullable={true}
                />
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleUpcLookup}
                disabled={isLookingUp || !form.watch("upc")}
                className="mb-[2px]"
              >
                {isLookingUp ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Search className="h-4 w-4" />
                )}
                <span className="ml-1">Lookup</span>
              </Button>
            </div>
            {lookupImageUrl && (
              <div className="flex items-center gap-2 text-muted-foreground text-sm">
                <Image
                  src={lookupImageUrl}
                  alt="Product from UPC lookup"
                  width={64}
                  height={64}
                  className="rounded border object-contain"
                />
                <span>Image will be imported on save</span>
              </div>
            )}
          </div>

          <NullableNumericField
            form={form}
            step="1"
            name="ndb_number"
            label="NDB Number (Optional)"
            placeholder="NDB number (1000-99999)"
          />
          <ComboboxFieldWithSearch
            form={form}
            name="ingredient"
            label="Ingredient"
            searchType="ingredient"
          />
        </>
      )}

      {/* Show image upload in both create and edit modes */}
      <PendingImageUpload
        entityType="PRODUCT"
        onImagesChange={handlePendingImagesChange}
        existingImages={
          mode === "edit" && product?.images ? product.images : []
        }
        onExistingImagesRemove={handleRemovedImagesChange}
        className="mt-4"
      />

      {/* Hide unit mappings for misc products */}
      {!isMisc && (
        <ArrayFieldManager<UnitMappingInput, ProductFormValues>
          form={form}
          name="unitMappings"
          title="Unit Mappings"
          addButtonText="Add Mapping"
          emptyValue={{
            a: { value: 1, unit: "" },
            b: { value: 1, unit: "" },
            source: null,
          }}
        >
          {(_, index) => (
            <>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <h5 className="font-medium text-sm">From</h5>
                  <AmountFieldGroup
                    form={form}
                    valuePath={`unitMappings.${index}.a.value`}
                    unitPath={`unitMappings.${index}.a.unit`}
                  />
                </div>

                <div className="space-y-2">
                  <h5 className="font-medium text-sm">To</h5>
                  <AmountFieldGroup
                    form={form}
                    valuePath={`unitMappings.${index}.b.value`}
                    unitPath={`unitMappings.${index}.b.unit`}
                  />
                </div>
              </div>

              <UnifiedTextField
                form={form}
                name={`unitMappings.${index}.source`}
                label="Source (Optional)"
                placeholder="Enter source"
                nullable={true}
              />
            </>
          )}
        </ArrayFieldManager>
      )}
    </FormWrapper>
  );
};
