import { externalIdInput } from "@cubby/schemas/external-id";
import type { IngredientId } from "@cubby/schemas/identifiers";
import type { ImageOut } from "@cubby/schemas/image";
import {
  type ProductCreateInput,
  type ProductTopLevelOut,
  productCategory,
} from "@cubby/schemas/product";
import {
  type UnitMappingInput,
  unitMappingInput,
} from "@cubby/schemas/unitmapping";
import { UNSPECIFIED_MANUFACTURER } from "@cubby/shared";
import { ndb, upc } from "@cubby/usda-schemas";
import { zodResolver } from "@hookform/resolvers/zod";
import { type FC, useEffect } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { getOptionalIngredientId } from "~/app/_components/form-fields";
import { useImageState } from "~/hooks/useImageState";
import {
  extractPriceFromMappings,
  syncPriceToMappings,
} from "~/lib/price-mapping-utils";
import { ComboboxItem } from "../combobox/combobox-types";
import {
  buildUpdateObject,
  type CreateModeProps,
  detectComboboxIdChange,
  type EditModeProps,
  FormWrapper,
  getSubmitButtonText,
} from "../form-utils";
import type { PendingImage } from "../PendingImageUpload";
import { ProductFormFields } from "./product-form-fields";

// Form schema for product form (simple Zod schema without z.custom)
const productFormSchema = z
  .object({
    name: z.string().min(1, "Name is required"),
    manufacturer: z.string().min(1, "Manufacturer is required"),
    model: z.string().nullable(),
    notes: z.string().nullable(),
    category: productCategory.nullable(),
    upc: upc.nullable(), // Allow empty string and transform to null
    ndb_number: ndb.nullable(), // Allow empty string and transform to null
    expectedQuantity: z.number().int().positive().nullable(),
    price: z.number().positive().nullable(), // Shortcut for 1 each → $X mapping
    ingredient: ComboboxItem.nullable(), // Ingredient association
    unitMappings: z.array(unitMappingInput),
    externalIds: z.array(externalIdInput),
  })
  .transform((data) => ({
    ...data,
    upc: data.upc === "" ? null : data.upc,
    ndb_number: data.ndb_number === 0 ? null : data.ndb_number,
  }));

type ProductFormValues = z.infer<typeof productFormSchema>;

// Props for create mode
interface CreateProductFormProps extends CreateModeProps<ProductCreateInput> {
  product?: never;
  initialName?: string;
  initialExpectedQuantity?: number | null;
  /** Pre-link the new product to an ingredient (used by the enrichment queue). */
  initialIngredient?: ComboboxItem | null;
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
      data: Partial<ProductCreateInput>;
    },
    ProductWithIngredient
  > {
  entity: ProductWithIngredient;
}

// Combined props type using discriminated union
type ProductFormProps = CreateProductFormProps | EditProductFormProps;

export const ProductForm: FC<ProductFormProps> = (props) => {
  const { mode, isPending, error, onCancel } = props;
  const imageState = useImageState();
  const { getImageData, hasImageChanges } = imageState;

  // Get the product entity in edit mode
  const product = mode === "edit" ? props.entity : undefined;
  const initialName = mode === "create" ? props.initialName : undefined;
  const initialExpectedQuantity =
    mode === "create" ? props.initialExpectedQuantity : undefined;
  const initialIngredient =
    mode === "create" ? props.initialIngredient : undefined;

  // Initialize form with default values or existing product data
  const form = useForm<ProductFormValues>({
    resolver: zodResolver(productFormSchema),
    defaultValues: {
      name: product ? product.name : (initialName ?? ""),
      manufacturer: product ? product.manufacturer : UNSPECIFIED_MANUFACTURER,
      model: product ? product.model : null,
      notes: product ? product.notes : null,
      category: product?.category ?? null,
      upc: product ? product.upc : null,
      ndb_number: product ? product.ndb_number : null,
      expectedQuantity: product
        ? product.expectedQuantity
        : (initialExpectedQuantity ?? null),
      price: null, // Will be set async in useEffect
      ingredient: product?.ingredient || initialIngredient || null,
      unitMappings: product?.unitMappings ?? [],
      externalIds: product?.externalIds ?? [],
    },
  });

  // Extract price from mappings
  useEffect(() => {
    const priceAmount = extractPriceFromMappings(product?.unitMappings ?? []);
    form.setValue("price", priceAmount?.value ?? null);
  }, [product?.unitMappings, form]);

  const handleSubmit = (values: ProductFormValues) => {
    // Sync price field to unitMappings before saving
    // Form uses numeric price (assumes dollar), convert to Amount
    const unitMappingsWithPrice = syncPriceToMappings(
      values.unitMappings,
      values.price !== null ? { value: values.price, unit: "dollar" } : null,
      "product-form",
    );

    if (mode === "create") {
      // For creation, pass all fields
      const createData: ProductCreateInput = {
        name: values.name,
        manufacturer: values.manufacturer,
        model: values.model,
        category: values.category,
        upc: values.upc,
        ndb_number: values.ndb_number,
        expectedQuantity: values.expectedQuantity,
        ingredientId: getOptionalIngredientId(values.ingredient) ?? null,
        unitMappings: unitMappingsWithPrice,
        externalIds: values.externalIds,
        ...getImageData(true), // Apply pending images for creation
      };

      props.onCreate(createData);
    } else if (mode === "edit" && product) {
      // In edit mode, determine which fields have changed
      const updates: Partial<ProductCreateInput> = buildUpdateObject(
        {
          ...product,
        },
        values,
        [
          "name",
          "manufacturer",
          "model",
          "notes",
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

      // Check for external ID changes
      if (
        JSON.stringify(product.externalIds) !==
        JSON.stringify(values.externalIds)
      ) {
        updates.externalIds = values.externalIds;
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

  const buttonText = getSubmitButtonText(mode);

  return (
    <FormWrapper
      form={form}
      onSubmit={handleSubmit}
      error={error}
      isPending={isPending}
      onCancel={onCancel}
      submitButtonText={buttonText}
    >
      <ProductFormFields
        form={form}
        imageHandlers={imageState}
        existingImages={
          mode === "edit" && product?.images ? product.images : []
        }
        pendingImages={imageState.pendingImages}
      />
    </FormWrapper>
  );
};
