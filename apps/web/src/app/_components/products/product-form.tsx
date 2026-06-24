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
import { fdcId, upc } from "@cubby/usda-schemas";
import { zodResolver } from "@hookform/resolvers/zod";
import type { FC } from "react";
import { type Control, useForm, useFormState, useWatch } from "react-hook-form";
import { z } from "zod";
import {
  getOptionalIngredientId,
  optionalIngredientField,
} from "~/app/_components/form-fields";
import { InfoRow } from "~/components/common/info-row";
import { InkStamp } from "~/components/ui/ink-stamp";
import { useImageState } from "~/hooks/useImageState";
import {
  isCanonicalPriceMapping,
  isMoneyUnit,
} from "~/lib/price-mapping-utils";
import { formatCurrency } from "~/lib/utils";
import type { ComboboxItem } from "../combobox/combobox-types";
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
    fdc_id: fdcId.nullable(), // Explicit USDA link (set via search)
    expectedQuantity: z.number().int().positive().nullable(),
    price: z.number().positive().nullable(), // Price per each ($); own field, not a mapping
    ingredient: optionalIngredientField, // Ingredient association
    // Per-each price has its own field, so a canonical "1 each = $X" conversion
    // is forbidden (it would duplicate the price). Per-measure money mappings
    // like "1 quart = $4" are allowed. Mirrors the server-side invariant so a
    // duplicate per-each price is caught before submit.
    unitMappings: z.array(unitMappingInput).superRefine((mappings, ctx) => {
      mappings.forEach((m, i) => {
        if (isCanonicalPriceMapping(m)) {
          const moneySide = isMoneyUnit(m.b.unit) ? "b" : "a";
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              "Use the Price per Item field for the per-each price, not a conversion.",
            path: [i, moneySide, "unit"],
          });
        }
      });
    }),
    externalIds: z.array(externalIdInput),
  })
  .transform((data) => ({
    ...data,
    upc: data.upc === "" ? null : data.upc,
    fdc_id: data.fdc_id === 0 ? null : data.fdc_id,
  }));

type ProductFormValues = z.infer<typeof productFormSchema>;

// Live tally for the sticky footer. dirtyFields (not isDirty) — registering
// nullable inputs materializes their objects and trips isDirty on load.
const ProductTally: FC<{ control: Control<ProductFormValues> }> = ({
  control,
}) => {
  const mappings = useWatch({ control, name: "unitMappings" });
  const externalIds = useWatch({ control, name: "externalIds" });
  const { dirtyFields } = useFormState({ control });
  const isDirty = Object.keys(dirtyFields).length > 0;

  return (
    <div className="flex min-w-0 items-center gap-2 font-mono text-2xs text-muted-foreground uppercase">
      <span className="truncate tabular-nums">
        {mappings?.length ?? 0} conversions · {externalIds?.length ?? 0}{" "}
        external IDs
      </span>
      {isDirty && <InkStamp tone="red">Unsaved</InkStamp>}
    </div>
  );
};

// Live fact-sheet preview: the product detail page's ledger rows, built from
// form state as you type. Display-only; renders partial drafts defensively.
const ProductLivePreview: FC<{ control: Control<ProductFormValues> }> = ({
  control,
}) => {
  const v = useWatch({ control }) as Partial<ProductFormValues>;

  return (
    <div>
      <h3 className="my-0 break-words font-bold font-heading text-lg tracking-tight">
        {v.name?.trim() || "Untitled product"}
      </h3>
      <div className="mt-2">
        <InfoRow label="Manufacturer">{v.manufacturer || undefined}</InfoRow>
        <InfoRow label="Category">{v.category ?? undefined}</InfoRow>
        <InfoRow label="Price">
          {v.price != null ? (
            <span className="font-mono tabular-nums">
              {formatCurrency(v.price)}
            </span>
          ) : undefined}
        </InfoRow>
        <InfoRow label="UPC">
          {v.upc ? <span className="font-mono">{v.upc}</span> : undefined}
        </InfoRow>
        <InfoRow label="USDA FDC ID">
          {v.fdc_id ? <span className="font-mono">{v.fdc_id}</span> : undefined}
        </InfoRow>
        <InfoRow label="Ingredient">{v.ingredient?.name || undefined}</InfoRow>
        <InfoRow label="Conversions">
          <span className="font-mono tabular-nums">
            {v.unitMappings?.length ?? 0}
          </span>
        </InfoRow>
      </div>
    </div>
  );
};

// Props for create mode
interface CreateProductFormProps extends CreateModeProps<ProductCreateInput> {
  product?: never;
  initialName?: string;
  initialExpectedQuantity?: number | null;
  /** Pre-link the new product to an ingredient (used by the enrichment queue). */
  initialIngredient?: ComboboxItem | null;
  /** Rendered inside a modal — use a plain inline footer instead of the page sticky bar. */
  embedded?: boolean;
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
  /** Rendered inside a modal — use a plain inline footer instead of the page sticky bar. */
  embedded?: boolean;
}

// Combined props type using discriminated union
type ProductFormProps = CreateProductFormProps | EditProductFormProps;

export const ProductForm: FC<ProductFormProps> = (props) => {
  const { mode, isPending, error, onCancel, embedded } = props;
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
      fdc_id: product ? product.fdc_id : null,
      expectedQuantity: product
        ? product.expectedQuantity
        : (initialExpectedQuantity ?? null),
      price: product?.price ?? null,
      ingredient: product?.ingredient || initialIngredient || null,
      unitMappings: product?.unitMappings ?? [],
      externalIds: product?.externalIds ?? [],
    },
  });

  const handleSubmit = (values: ProductFormValues) => {
    if (mode === "create") {
      // For creation, pass all fields
      const createData: ProductCreateInput = {
        name: values.name,
        manufacturer: values.manufacturer,
        model: values.model,
        category: values.category,
        upc: values.upc,
        fdc_id: values.fdc_id,
        expectedQuantity: values.expectedQuantity,
        price: values.price,
        ingredientId: getOptionalIngredientId(values.ingredient) ?? null,
        unitMappings: values.unitMappings,
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
          "fdc_id",
          "expectedQuantity",
          "price",
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

      // Check for unit mapping changes (measurement conversions only; price is its own field)
      if (
        JSON.stringify(product.unitMappings) !==
        JSON.stringify(values.unitMappings)
      ) {
        updates.unitMappings = values.unitMappings;
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
      successMessage={mode === "create" ? "Product created" : "Product saved"}
      stickyFooter={!embedded}
      footerStart={
        embedded ? undefined : <ProductTally control={form.control} />
      }
    >
      {/* Container query (not viewport): the fields + live-preview split
          activates on the FORM's own width, so it works whether it's full-page,
          in a wide modal, or stacked inside a narrow detail card. The
          @container must sit on a PARENT of the queried grid — a container
          never queries its own size. */}
      <div className="@container/product">
        <div className="@3xl/product:grid @3xl/product:grid-cols-[minmax(0,1fr)_minmax(360px,400px)] @3xl/product:items-start gap-6">
          <div className="space-y-4">
            <ProductFormFields
              form={form}
              imageHandlers={imageState}
              existingImages={
                mode === "edit" && product?.images ? product.images : []
              }
              pendingImages={imageState.pendingImages}
            />
          </div>

          {/* Live fact-sheet — the detail page builds as you type */}
          <aside className="@3xl/product:sticky @3xl/product:top-20 @3xl/product:block hidden">
            <div className="max-h-[75vh] overflow-y-auto rounded-lg border border-[var(--border-chunky)] bg-card p-4 shadow-[var(--shadow-chunky)]">
              <p className="eyebrow mb-2">Live preview</p>
              <ProductLivePreview control={form.control} />
            </div>
          </aside>
        </div>
      </div>
    </FormWrapper>
  );
};
