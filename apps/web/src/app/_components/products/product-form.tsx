import { displayGtin, type ExternalIdInput } from "@cubby/schemas/external-id";
import { productCategoryShortcode } from "@cubby/schemas/identifiers";
import { type ImageOut, partitionEntityFiles } from "@cubby/schemas/image";
import {
  type ProductLabelNutrition,
  productLabelNutrition,
} from "@cubby/schemas/nutrition";
import {
  type ProductCreateInput,
  type ProductTopLevelOut,
} from "@cubby/schemas/product";
import {
  type UnitMappingInput,
  unitMappingInput,
} from "@cubby/schemas/unitmapping";
import { UNSPECIFIED_MANUFACTURER } from "@cubby/shared";
import {
  collectionSlugsFromTags,
  collectionTagFromSlug,
  isCollectionTag,
  normalizeCollectionSlug,
} from "@cubby/shared/collection-tag";
import { fdcId, isNutrientKey, upc } from "@cubby/usda-schemas";
import { type FC, useMemo } from "react";
import { type Control, useFormState, useWatch } from "react-hook-form";
import { z } from "zod";

import { FieldSuggestionProvider } from "~/app/_components/ai/field-suggestion-provider";
import { getOptionalIngredientId } from "~/app/_components/form-fields";
import { useProductCategories } from "~/app/_components/hooks/useProductCategories";
import { InfoRow } from "~/components/common/info-row";
import { filterAliases } from "~/components/forms/aliases-field";
import { Row, Stack } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import { useEntityFormController } from "~/entities/editing/use-entity-form-controller";
import { useImageState } from "~/hooks/useImageState";
import {
  isCanonicalPriceMapping,
  isMoneyUnit,
} from "~/lib/price-mapping-utils";
import { formatCurrency } from "~/lib/utils";
import { wasm } from "~/lib/wasm";

import type { ComboboxItem } from "../combobox/combobox-types";
import { type EntityFormProps, FormWrapper } from "../form-utils";
import {
  EMPTY_LABEL_NUTRITION_DRAFT,
  isbnFormField,
  type LabelNutritionFormValue,
  type ProductFormFieldPaths,
  ProductFormFields,
} from "./product-form-fields";

// Module-level so `useEntityFormController`'s resolver memoization sees a
// stable reference across renders (never a fresh inline array/object).
const PRODUCT_FORM_FIELDS = [
  "name",
  "aliases",
  "tags",
  "manufacturer",
  "model",
  "notes",
  "categoryId",
  "upc",
  "isbn",
  "fdc_id",
  "expectedQuantity",
  "price",
  "ingredientId",
  "unitMappings",
  "labelNutrition",
  "externalIds",
] as const;

// Classification is edited by EntityValueField, which persists the selected
// CAT shortcode in `categoryId` rather than a ComboboxItem sibling.
const PRODUCT_FORM_REFERENCE_PATHS = { categoryId: null } as const;

// The `LabelNutritionFormValue` shape RHF actually holds mid-edit — looser
// than `ProductLabelNutrition` (serving grams may be typed before any
// nutrient is, and a nutrient input may be blank rather than a number). This
// is the schema's own I/O boundary: parsing into it (rather than a raw
// `typeof` check on `unknown`) is what lets the `.transform` below branch on
// a real domain value instead of a bare representation check. Every leaf
// tolerates `undefined` too — a never-touched nutrient input stays an
// unregistered RHF path (its value comes back `undefined`, not `null`) until
// the user types in it.
const labelNutritionDraft = z.object({
  servingGrams: z.number().nullable().optional(),
  source: z.string().nullable().optional(),
  nutrients: z.record(z.string(), z.number().nullable().optional()).optional(),
});

// A half-filled draft is transformed into the real, stricter
// `ProductLabelNutrition | null`: `servingGrams: null` collapses the whole
// field to `null` ("no label"); otherwise blank nutrient entries are dropped
// (an explicit 0 is kept — measured data, not "not entered") before piping
// into `productLabelNutrition`'s own refine, so "serving grams set, no
// nutrients" surfaces as a normal field error instead of a thrown submit.
const labelNutritionField = labelNutritionDraft
  .nullable()
  .optional()
  .transform((draft) => {
    if (draft == null || draft.servingGrams == null) return null;
    const nutrients: Record<string, number> = {};
    for (const [key, amount] of Object.entries(draft.nutrients ?? {})) {
      if (amount != null && isNutrientKey(key)) {
        nutrients[key] = amount;
      }
    }
    return {
      servingGrams: draft.servingGrams,
      nutrients,
      source: draft.source ?? null,
    };
  })
  .pipe(productLabelNutrition.nullable());

// Fields the generated create/update schema map doesn't cover the way this
// form needs:
// - `collections` is editor-only, folded into `tags` at submit (no server
//   counterpart of its own).
// - `upc`/`isbn`/`fdc_id` keep their own friendlier, display-oriented client
//   schemas rather than the server's canonicalizing ones (the server's `upc`
//   validator normalizes to a padded GTIN-14, which would fight the raw
//   digits `ProductLivePreview`/`buildUpdateObject` compare against).
// - `unitMappings` keeps the cross-field guard against a duplicate per-each
//   price mapping, which the generated schema doesn't express.
// - `labelNutrition` swaps in `labelNutritionField` (above) so the form can
//   hold a looser mid-edit draft than the stored shape.
const PRODUCT_FORM_EXTEND = {
  collections: z.array(z.string()),
  upc: upc.nullable(),
  isbn: isbnFormField.nullable(),
  fdc_id: fdcId.nullable(),
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
  labelNutrition: labelNutritionField,
};

interface ProductFormValues {
  name: string;
  aliases: string[];
  tags: string[];
  // Editor-only: folded into `tags` at submit (see `productTags`).
  collections: string[];
  manufacturer: string;
  model: string | null;
  notes: string | null;
  categoryId: string | null;
  upc: string | null;
  isbn: string | null;
  fdc_id: number | null;
  expectedQuantity: number | null;
  // Price per each ($); own field, not a mapping. 0 is allowed and means
  // "genuinely free" (bundled accessories) — distinct from null, "unpriced".
  price: number | null;
  ingredient: ComboboxItem | null;
  unitMappings: UnitMappingInput[];
  externalIds: ExternalIdInput[];
  labelNutrition: LabelNutritionFormValue;
}

const productFormFieldPaths = {
  name: "name",
  manufacturer: "manufacturer",
  model: "model",
  notes: "notes",
  categoryId: "categoryId",
  upc: "upc",
  isbn: "isbn",
  fdcId: "fdc_id",
  expectedQuantity: "expectedQuantity",
  price: "price",
  ingredient: "ingredient",
  unitMappings: "unitMappings",
  externalIds: "externalIds",
  unitMapping: (index: number) => ({
    valueA: `unitMappings.${index}.a.value`,
    unitA: `unitMappings.${index}.a.unit`,
    valueB: `unitMappings.${index}.b.value`,
    unitB: `unitMappings.${index}.b.unit`,
    source: `unitMappings.${index}.source`,
  }),
  externalId: (index: number) => ({
    kind: `externalIds.${index}.kind`,
    source: `externalIds.${index}.source`,
    externalId: `externalIds.${index}.externalId`,
    url: `externalIds.${index}.url`,
  }),
  labelNutrition: {
    servingGrams: "labelNutrition.servingGrams",
    source: "labelNutrition.source",
    nutrient: (key) => `labelNutrition.nutrients.${key}`,
  },
} satisfies ProductFormFieldPaths<ProductFormValues>;

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
    <Row
      align="center"
      gap="sm"
      className="min-w-0 font-mono text-2xs text-muted-foreground uppercase"
    >
      <span className="truncate tabular-nums">
        {mappings?.length ?? 0} conversions · {externalIds?.length ?? 0}{" "}
        external IDs
      </span>
      {isDirty && <Badge variant="destructive">Unsaved</Badge>}
    </Row>
  );
};

// Live fact-sheet preview: the product detail page's ledger rows, built from
// form state as you type. Display-only; renders partial drafts defensively.
const ProductLivePreview: FC<{ control: Control<ProductFormValues> }> = ({
  control,
}) => {
  // SAFETY: the form is intentionally observed without a field name for this
  // display-only preview; its schema owns the partial product draft shape.
  const v = useWatch({ control }) as Partial<ProductFormValues>;
  const { categories } = useProductCategories();
  const categoryPath = categories
    .find((category) => category.id === v.categoryId)
    ?.path.map((node) => node.name)
    .join(" / ");

  return (
    <div>
      <h3 className="my-0 font-heading text-lg font-bold tracking-tight break-words">
        {v.name?.trim() || "Untitled product"}
      </h3>
      <div className="mt-2">
        <InfoRow label="Manufacturer">{v.manufacturer || undefined}</InfoRow>
        <InfoRow label="Classification">{categoryPath}</InfoRow>
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
        <InfoRow label="ISBN">
          {v.isbn ? (
            <span className="font-mono">
              {wasm.normalize_isbn(v.isbn)?.isbn13 ??
                wasm.isbn_from_gtin(v.isbn)?.isbn13 ??
                v.isbn}
            </span>
          ) : undefined}
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

// Define a custom type for product with ingredient and unit mappings
interface ProductWithIngredient extends Omit<ProductTopLevelOut, "images"> {
  ingredient?: {
    id: string;
    name: string;
  } | null;
  unitMappings: UnitMappingInput[];
  images?: ImageOut[];
}

type ProductFormProps = EntityFormProps<
  ProductCreateInput,
  { id: string; data: Partial<ProductCreateInput> },
  ProductWithIngredient
> & {
  product?: never;
  initialName?: string;
  initialExpectedQuantity?: number | null;
  /** Pre-link the new product to an ingredient (used by the enrichment queue). */
  initialIngredient?: ComboboxItem | null;
  /**
   * USDA-food-derived prefill (the food-detail page's "create product" /
   * "link to an ingredient" actions). `initialCategory` is deliberately not
   * offered — `category` self-corrects server-side via `hasFoodIndicators`
   * once `fdc_id` is set, so prefilling it here would just race that logic.
   */
  initialManufacturer?: string;
  initialUpc?: string | null;
  initialFdcId?: number | null;
  /** Rendered inside a modal — use a plain inline footer instead of the page sticky bar. */
  embedded?: boolean;
};

type ProductFormInitialValues = {
  initialName?: string;
  initialExpectedQuantity?: number | null;
  initialIngredient?: ProductWithIngredient["ingredient"];
  initialManufacturer?: string;
  initialUpc?: string | null;
  initialFdcId?: number | null;
};

function createProductFormDefaults({
  initialName,
  initialExpectedQuantity,
  initialIngredient,
  initialManufacturer,
  initialUpc,
  initialFdcId,
}: ProductFormInitialValues): ProductFormValues {
  return {
    name: initialName ?? "",
    aliases: [],
    tags: [],
    collections: [],
    manufacturer: initialManufacturer ?? UNSPECIFIED_MANUFACTURER,
    model: null,
    notes: null,
    categoryId: null,
    upc: initialUpc ?? null,
    isbn: null,
    fdc_id: initialFdcId ?? null,
    expectedQuantity: initialExpectedQuantity ?? null,
    price: null,
    ingredient: initialIngredient ?? null,
    unitMappings: [],
    externalIds: [],
    labelNutrition: EMPTY_LABEL_NUTRITION_DRAFT,
  };
}

/** Hydrate the form's looser mid-edit draft from a stored label override —
 * see `labelNutritionField` for the reverse (draft → stored) direction. */
function labelNutritionFormDefaults(
  labelNutrition: ProductLabelNutrition | null,
): LabelNutritionFormValue {
  if (!labelNutrition) return EMPTY_LABEL_NUTRITION_DRAFT;
  return {
    servingGrams: labelNutrition.servingGrams,
    source: labelNutrition.source,
    nutrients: { ...labelNutrition.nutrients },
  };
}

function editProductFormDefaults(
  product: ProductWithIngredient,
  productIsbn: ReturnType<typeof wasm.isbn_from_gtin>,
): ProductFormValues {
  return {
    name: product.name,
    aliases: product.aliases,
    tags: product.tags.filter((tag) => !isCollectionTag(tag)),
    collections: collectionSlugsFromTags(product.tags),
    manufacturer: product.manufacturer,
    model: product.model,
    notes: product.notes,
    categoryId: product.category?.id ?? null,
    upc:
      product.primaryGtin && !productIsbn
        ? displayGtin(product.primaryGtin)
        : null,
    isbn: productIsbn?.isbn13 ?? null,
    fdc_id: product.fdc_id,
    expectedQuantity: product.expectedQuantity,
    price: product.price,
    ingredient: product.ingredient ?? null,
    unitMappings: product.unitMappings,
    externalIds: product.externalIds,
    labelNutrition: labelNutritionFormDefaults(product.labelNutrition),
  };
}

function productFormDefaults({
  product,
  initialName,
  initialExpectedQuantity,
  initialIngredient,
  initialManufacturer,
  initialUpc,
  initialFdcId,
  productIsbn,
}: ProductFormInitialValues & {
  product?: ProductWithIngredient;
  productIsbn: ReturnType<typeof wasm.isbn_from_gtin>;
}): ProductFormValues {
  return product
    ? editProductFormDefaults(product, productIsbn)
    : createProductFormDefaults({
        initialName,
        initialExpectedQuantity,
        initialIngredient,
        initialManufacturer,
        initialUpc,
        initialFdcId,
      });
}

function productTags(values: ProductFormValues) {
  return [
    ...filterAliases(values.tags),
    ...filterAliases(values.collections)
      .map(normalizeCollectionSlug)
      .filter(Boolean)
      .map(collectionTagFromSlug),
  ];
}

/**
 * Normalize raw form values into their submit-ready shape: fold
 * tags/collections, filter blank aliases, and strip the "" / 0 sentinels the
 * text/number inputs can produce for a field that's really `null` ("" for a
 * cleared UPC field, `0` for a `fdc_id` typed then cleared to a bare zero).
 * Shared by `transform.create` and `transform.diffValues` so create and edit
 * submits see the same submit-ready values.
 */
function normalizeProductValues(values: ProductFormValues): ProductFormValues {
  return {
    ...values,
    aliases: filterAliases(values.aliases),
    tags: productTags(values),
    upc: values.upc === "" ? null : values.upc,
    fdc_id: values.fdc_id === 0 ? null : values.fdc_id,
  };
}

function createProductInput(
  values: ProductFormValues,
  imageData: ReturnType<ReturnType<typeof useImageState>["getImageData"]> & {
    pendingImagePurposes?: Record<string, "item" | "label">;
  },
): ProductCreateInput {
  return {
    name: values.name,
    aliases: values.aliases,
    tags: values.tags,
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
    ingredientId: getOptionalIngredientId(values.ingredient) ?? null,
    unitMappings: values.unitMappings,
    externalIds: values.externalIds,
    // `values.labelNutrition` reaches here already transformed by the
    // resolver's `labelNutritionField` schema (RHF's zodResolver hands
    // `handleSubmit` the schema's *output*, not the raw form draft), so this
    // re-parse is a cheap, honest boundary check rather than a cast — the
    // looser `LabelNutritionFormValue` type on `ProductFormValues` describes
    // the mid-edit shape, not this already-validated runtime value.
    labelNutrition: productLabelNutrition
      .nullable()
      .parse(values.labelNutrition),
    ...imageData,
  };
}

export const ProductForm: FC<ProductFormProps> = (props) => {
  const { mode, onCancel, embedded } = props;
  const imageState = useImageState();
  const { getImageData, getPendingImagePurposes, hasImageChanges } = imageState;

  const product = mode === "edit" ? props.entity : undefined;

  // PDF manuals share the images relation; split them so the image editor
  // (cover/reorder) only sees displayable images.
  const { images: existingImages, documents: existingDocuments } = useMemo(
    () =>
      partitionEntityFiles(
        mode === "edit" && product
          ? [...(product.images ?? []), ...(product.labelImages ?? [])]
          : [],
      ),
    [mode, product],
  );
  const initialName = mode === "create" ? props.initialName : undefined;
  const initialExpectedQuantity =
    mode === "create" ? props.initialExpectedQuantity : undefined;
  const initialIngredient =
    mode === "create" ? props.initialIngredient : undefined;
  const initialManufacturer =
    mode === "create" ? props.initialManufacturer : undefined;
  const initialUpc = mode === "create" ? props.initialUpc : undefined;
  const initialFdcId = mode === "create" ? props.initialFdcId : undefined;
  const productIsbn =
    product?.primaryGtin == null
      ? undefined
      : wasm.isbn_from_gtin(product.primaryGtin);

  const controller = useEntityFormController("product", props, {
    fields: PRODUCT_FORM_FIELDS,
    referencePaths: PRODUCT_FORM_REFERENCE_PATHS,
    extend: PRODUCT_FORM_EXTEND,
    defaultValues: productFormDefaults({
      product,
      initialName,
      initialExpectedQuantity,
      initialIngredient,
      initialManufacturer,
      initialUpc,
      initialFdcId,
      productIsbn,
    }),
    hasAdditionalChanges: hasImageChanges,
    transform: {
      diffValues: (values) => normalizeProductValues(values),
      // `upc` is a write-only input; the product carries `primaryGtin`.
      // Compare in the form's own units so an unchanged barcode isn't
      // resubmitted as a change on every save.
      diffRecord: (record) => ({
        upc:
          record.primaryGtin && !productIsbn
            ? displayGtin(record.primaryGtin)
            : null,
        isbn: productIsbn?.gtin14 ?? null,
      }),
      create: (values) =>
        createProductInput(normalizeProductValues(values), {
          ...getImageData(true),
          pendingImagePurposes: getPendingImagePurposes(),
        }),
      edit: (updates) => ({
        id: product!.id,
        data: {
          ...updates,
          ...getImageData(),
          // Product's generated update schema owns this field; it is separate
          // from generic gallery data because attachment roles are Product-only.
          pendingImagePurposes: getPendingImagePurposes(),
        },
      }),
    },
  });
  const { form, handleSubmit, isPending, error, submitButtonText } = controller;
  const classificationEvidenceBasis = useMemo(
    () =>
      product
        ? { classificationEvidence: product.classificationEvidence }
        : undefined,
    [product],
  );

  return (
    <FormWrapper
      form={form}
      onSubmit={handleSubmit}
      error={error}
      isPending={isPending}
      onCancel={onCancel}
      submitButtonText={submitButtonText}
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
      <FieldSuggestionProvider
        entity="product"
        mode={product ? "edit" : "create"}
        // Explicit roster: `product.tags` is the entity's only other
        // `control.suggest` field (a `mode: "prune"` target once the tag
        // pruning work lands), and a form-mode provider has no business
        // firing that target — pruning is a record-surface operation until
        // the tags `ChipsInput` wiring lands. Naming `categoryId` alone keeps
        // this provider scoped to `fill` targets even after that lands.
        fieldKeys={["categoryId"]}
        staticBasis={classificationEvidenceBasis}
        paths={{
          name: productFormFieldPaths.name,
          manufacturer: productFormFieldPaths.manufacturer,
        }}
      >
        <div className="@container/product">
          <div className="gap-6 @3xl/product:grid @3xl/product:grid-cols-[minmax(0,1fr)_minmax(360px,400px)] @3xl/product:items-start">
            <Stack>
              <ProductFormFields
                mode={product ? "edit" : "create"}
                form={form}
                paths={productFormFieldPaths}
                imageHandlers={imageState}
                existingImages={existingImages}
                existingDocuments={existingDocuments}
                documentFolder={product?.id ?? undefined}
                pendingImages={imageState.pendingImages}
              />
            </Stack>

            {/* Live fact-sheet — the detail page builds as you type */}
            <aside className="hidden @3xl/product:sticky @3xl/product:top-20 @3xl/product:block">
              <div className="max-h-[75vh] overflow-y-auto border border-[var(--border)] bg-card p-4">
                <p className="mb-2 eyebrow">Live preview</p>
                <ProductLivePreview control={form.control} />
              </div>
            </aside>
          </div>
        </div>
      </FieldSuggestionProvider>
    </FormWrapper>
  );
};
