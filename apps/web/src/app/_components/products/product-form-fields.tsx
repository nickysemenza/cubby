import {
  type ExternalIdInput,
  externalIdKind,
} from "@cubby/schemas/external-id";
import type { UnitMappingInput } from "@cubby/schemas/unitmapping";
import type { FoodSummaryWithLinkedProducts } from "@cubby/schemas/usda";
import { isMiscProduct } from "@cubby/shared";
import { type NutrientKey, TIER1_NUTRIENTS } from "@cubby/usda-schemas";
import { ChevronRight, Search } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import type {
  FieldPathByValue,
  FieldValues,
  Path,
  PathValue,
  UseFormReturn,
} from "react-hook-form";
import { useWatch } from "react-hook-form";
import { z } from "zod";

import { basisValueOf } from "~/app/_components/ai/field-suggestion";
import { showErrorToast } from "~/components/feedback/error-details";
import { AliasesField } from "~/components/forms/aliases-field";
import { ArrayFieldManager } from "~/components/forms/array-field-manager";
import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { Card, CardContent } from "~/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "~/components/ui/collapsible";
import { Description } from "~/components/ui/description";
import { FieldError } from "~/components/ui/field";
import { Image } from "~/components/ui/image";
import { Spinner } from "~/components/ui/spinner";
import type { EditMode } from "~/entities/editing/entity-field-presentation";
import { EntityPrimitiveFields } from "~/entities/editing/entity-primitive-fields";
import type { useImageState } from "~/hooks/useImageState";
import { upc } from "~/lib/upc.functions";
import { wasm } from "~/lib/wasm";

import type { ComboboxItem } from "../combobox/combobox-types";
import { referenceEntitySearch } from "../combobox/reference-entity-search";
import { UsdaFoodSearchField } from "../combobox/with-usda-food-search";
import {
  NullableNumericField,
  SelectField,
  SideBySideFields,
  UnifiedTextField,
} from "../form-utils";
import { ComboboxFieldWithSearch } from "../form-utils/combobox-field-with-search";
import { EntityValueField } from "../form-utils/entity-value-field";
import {
  type PendingDocument,
  PendingDocumentUpload,
} from "../PendingDocumentUpload";
import { type PendingImage, PendingImageUpload } from "../PendingImageUpload";
import { UnitMappingPairField } from "../units/unit-mapping-pair-field";
import { ExternalIdKindSuggestion } from "./external-id-kind-suggestion";
import { IdentifyProductButton } from "./identify-product-with-ai";

const EMPTY_PENDING_IMAGES: PendingImage[] = [];

/**
 * Visual grouping for the product form. In `compact` mode (QuickInventoryAdd) it
 * renders children flat — the compact card is already small. In the full form it
 * adds a sentence-case group heading over a hairline, or — for the vitals
 * group — a chunky spec plate
 * (`plate`), so the long field list reads as the entity's placard + sections.
 */
function FormSection({
  title,
  compact,
  plate,
  children,
}: {
  title: string;
  compact?: boolean;
  /** Render as the chunky spec-plate card (no header) instead of a section. */
  plate?: boolean;
  children: ReactNode;
}) {
  if (compact) return <>{children}</>;
  if (plate) {
    return (
      <Card>
        <CardContent className="space-y-2 px-4 py-1">{children}</CardContent>
      </Card>
    );
  }
  return (
    <Stack as="section" gap="sm">
      <h4 className="my-0 border-t border-border pt-2 text-xs font-medium text-muted-foreground">
        {title}
      </h4>
      {children}
    </Stack>
  );
}

type ImageHandlers = Pick<
  ReturnType<typeof useImageState>,
  | "handlePendingImagesChange"
  | "handleRemovedImagesChange"
  | "handleExistingImagePurposesChange"
  | "handlePendingDocumentsChange"
  | "handleRemovedDocumentsChange"
  // Read by `ProductMediaFields` to keep a just-removed existing image out of
  // `IdentifyProductButton`'s read set — the removal is client-only until
  // save, so the id would otherwise still resolve to a live R2 URL.
  | "removedImageIds"
>;

type ProductTextPath<TFieldValues extends FieldValues> = FieldPathByValue<
  TFieldValues,
  string | null | undefined
>;
type ProductNumberPath<TFieldValues extends FieldValues> = FieldPathByValue<
  TFieldValues,
  number | null | undefined
>;
type ProductPickerPath<TFieldValues extends FieldValues> = FieldPathByValue<
  TFieldValues,
  ComboboxItem | null | undefined
>;

/**
 * The `labelNutrition` form draft: looser than `ProductLabelNutrition` so a
 * half-filled form (serving grams entered, no nutrients yet) is representable
 * mid-edit. `servingGrams: null` means "no label" — the resolver's
 * `labelNutritionField` preprocess (see `product-form.tsx`) is what turns
 * this into the real `ProductLabelNutrition | null` at submit time, filtering
 * blank nutrient entries and collapsing to `null` when serving grams is
 * empty. An explicit `0` in a nutrient field is kept (measured data), unlike
 * a blank/`null` one (not yet entered).
 */
export interface LabelNutritionFormValue {
  servingGrams: number | null;
  source: string | null;
  nutrients: Partial<Record<NutrientKey, number | null>>;
}

export const EMPTY_LABEL_NUTRITION_DRAFT: LabelNutritionFormValue = {
  servingGrams: null,
  source: null,
  nutrients: {},
};

export interface ProductFormFieldPaths<TFieldValues extends FieldValues> {
  name: ProductTextPath<TFieldValues>;
  manufacturer: ProductTextPath<TFieldValues>;
  model: ProductTextPath<TFieldValues>;
  notes: ProductTextPath<TFieldValues>;
  categoryId: ProductTextPath<TFieldValues>;
  upc: ProductTextPath<TFieldValues>;
  isbn: ProductTextPath<TFieldValues>;
  fdcId: ProductNumberPath<TFieldValues>;
  expectedQuantity: ProductNumberPath<TFieldValues>;
  price: ProductNumberPath<TFieldValues>;
  ingredient: ProductPickerPath<TFieldValues>;
  unitMappings: Path<TFieldValues>;
  externalIds?: Path<TFieldValues>;
  unitMapping: (index: number) => {
    valueA: ProductNumberPath<TFieldValues>;
    unitA: ProductTextPath<TFieldValues>;
    valueB: ProductNumberPath<TFieldValues>;
    unitB: ProductTextPath<TFieldValues>;
    source: ProductTextPath<TFieldValues>;
  };
  externalId?: (index: number) => {
    kind: ProductTextPath<TFieldValues>;
    source: ProductTextPath<TFieldValues>;
    externalId: ProductTextPath<TFieldValues>;
    url: ProductTextPath<TFieldValues>;
  };
  /** Omitted by forms with no `labelNutrition` field of their own (e.g. the
   * compact quick-inventory-add create form) — `LabelNutritionFields` only
   * mounts when this is present. */
  labelNutrition?: {
    servingGrams: ProductNumberPath<TFieldValues>;
    source: ProductTextPath<TFieldValues>;
    nutrient: (key: NutrientKey) => ProductNumberPath<TFieldValues>;
  };
}

function setProductField<
  TFieldValues extends FieldValues,
  TName extends Path<TFieldValues>,
>(
  form: UseFormReturn<TFieldValues>,
  name: TName,
  value: string | number,
  options?: Parameters<UseFormReturn<TFieldValues>["setValue"]>[2],
) {
  // SAFETY: `ProductFormFieldPaths` pairs every mutation target with this
  // product form's scalar domain; callers never route this helper to arrays.
  form.setValue(name, value as PathValue<TFieldValues, TName>, options);
}

const observedProductFieldsSchema = z.object({
  name: z.string(),
  manufacturer: z.string(),
  fdc_id: z.number().nullable(),
  upc: z.string().nullable(),
  isbn: z.string().nullable(),
  ingredient: z.unknown(),
});

/**
 * Client-side counterpart to the deleted `@cubby/schemas/isbn`'s `isbn` Zod
 * export: trims, then validates + normalizes to the canonical GTIN-14 via the
 * WASM boundary. `packages/schemas` cannot depend on `@cubby/recipebridge`
 * (it must stay isomorphic), so this lives with the two product forms
 * (`ProductForm`, `QuickInventoryAdd`) that need it for their own zod
 * resolver — everywhere else reads through `wasm.normalize_isbn` directly.
 */
export const isbnFormField = z
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

export interface ProductFormFieldValues extends FieldValues {
  name: string;
  manufacturer: string;
  model: string | null;
  notes: string | null;
  categoryId: string | null;
  upc: string | null;
  isbn: string | null;
  fdc_id: number | null;
  expectedQuantity: number | null;
  price: number | null;
  ingredient: ComboboxItem | null;
  unitMappings: UnitMappingInput[];
  aliases?: string[];
  tags?: string[];
  collections?: string[];
  externalIds?: ExternalIdInput[];
  /** Omitted by forms with no label-nutrition UI of their own — see
   * `ProductFormFieldPaths.labelNutrition`. */
  labelNutrition?: LabelNutritionFormValue;
}

interface ProductFormFieldsProps<TFieldValues extends ProductFormFieldValues> {
  mode: EditMode;
  form: UseFormReturn<TFieldValues>;
  paths: ProductFormFieldPaths<TFieldValues>;
  imageHandlers: ImageHandlers;
  existingImages?: PendingImage[];
  /** Already-attached PDF manuals (edit mode). */
  existingDocuments?: PendingDocument[];
  /** R2 folder for new manuals — the product shortcode (edit mode only). */
  documentFolder?: string;
  /** Pending images for AI product identification */
  pendingImages?: PendingImage[];
  /** When true, skips the Name+Model SideBySideFields row */
  hideNameField?: boolean;
  /** When true, skips the Price field (rendered by parent instead) */
  hidePrice?: boolean;
  /** When true, wraps fields in a muted card and reduces heading sizes */
  compact?: boolean;
}

type ProductFormSectionProps<TFieldValues extends ProductFormFieldValues> =
  Pick<ProductFormFieldsProps<TFieldValues>, "form" | "paths" | "compact">;

function ProductDetailsFields<TFieldValues extends ProductFormFieldValues>({
  mode,
  form,
  paths,
  compact,
  hideNameField,
  isMisc,
}: ProductFormSectionProps<TFieldValues> & {
  mode: EditMode;
  hideNameField: boolean;
  isMisc: boolean;
}) {
  return (
    <FormSection title="Product details" compact={compact} plate>
      {!hideNameField && (
        <SideBySideFields>
          <EntityPrimitiveFields
            entity="product"
            mode={mode}
            section="identity-model"
            paths={{ model: paths.model }}
            options={{ model: { placeholder: "Enter model number" } }}
          />
          <EntityPrimitiveFields
            entity="product"
            mode={mode}
            section="identity-name"
            paths={{ name: paths.name }}
            options={{ name: { placeholder: "Enter product name" } }}
          />
        </SideBySideFields>
      )}

      <EntityPrimitiveFields
        entity="product"
        mode={mode}
        section="notes"
        paths={{ notes: paths.notes }}
        options={{
          notes: { placeholder: "Notes, URLs, etc. — Markdown supported" },
        }}
      />

      {!isMisc && (
        <SideBySideFields>
          <EntityPrimitiveFields
            entity="product"
            mode={mode}
            section="manufacturer"
            paths={{ manufacturer: paths.manufacturer }}
            options={{
              manufacturer: { placeholder: "Enter manufacturer" },
            }}
          />
          <EntityValueField
            form={form}
            name={paths.categoryId}
            entity="productCategory"
            label="Classification"
            placeholder="Search classifications…"
            clearable
            SearchProvider={referenceEntitySearch("productCategory")}
            suggestField="categoryId"
          />
        </SideBySideFields>
      )}
    </FormSection>
  );
}

function ProductTagFields<TFieldValues extends ProductFormFieldValues>({
  form,
  compact,
}: Pick<ProductFormSectionProps<TFieldValues>, "form" | "compact">) {
  if (compact) return null;
  return (
    <>
      <AliasesField<TFieldValues> form={form} />
      <AliasesField<TFieldValues>
        form={form}
        name="collections"
        title="Collections"
        addButtonText="Add Collection"
        placeholder="e.g. painting"
      />
      <AliasesField<TFieldValues>
        form={form}
        name="tags"
        title="Compatibility tags"
        addButtonText="Add Tag"
        placeholder="e.g. grinder-4.5in, M18"
      />
    </>
  );
}

function ProductUpcField<TFieldValues extends ProductFormFieldValues>({
  form,
  paths,
  upcValue,
  lookupImageUrl,
  isLookingUp,
  onLookup,
}: Pick<ProductFormSectionProps<TFieldValues>, "form" | "paths"> & {
  upcValue: string | null;
  lookupImageUrl: string | null;
  isLookingUp: boolean;
  onLookup: () => void;
}) {
  return (
    <Stack gap="sm">
      <Row align="end" gap="sm">
        <div className="flex-1">
          <UnifiedTextField
            form={form}
            name={paths.upc}
            label="UPC (Optional)"
            placeholder="12-digit UPC code"
            nullable={true}
          />
        </div>
        <Button
          type="button"
          variant="outline"
          onClick={onLookup}
          disabled={isLookingUp || !upcValue}
        >
          {isLookingUp ? <Spinner /> : <Search className="size-4" />}
          <span className="ml-1">Lookup</span>
        </Button>
      </Row>
      {lookupImageUrl && (
        <Row align="center" gap="sm" className="text-sm text-muted-foreground">
          <Image
            src={lookupImageUrl}
            alt="Product from UPC lookup"
            width={64}
            height={64}
            displayWidth={64}
            className="rounded border object-contain"
          />
          <span>Image will be imported on save</span>
        </Row>
      )}
    </Stack>
  );
}

// FDA Nutrition Facts label order: the macro block (Calories, then Total Fat
// / Saturated Fat, Cholesterol, Sodium, Carbohydrate / Fiber, Protein),
// followed by the rest in `TIER1_NUTRIENTS`' own grouping (minerals, then
// vitamins) — matches `NutritionLabel`'s `ROW_ORDER` so the read and edit
// surfaces agree on nutrient ordering.
const LABEL_NUTRIENT_ORDER: readonly NutrientKey[] = [
  "kcal",
  "fat",
  "saturated_fat",
  "cholesterol",
  "sodium",
  "carbs",
  "fiber",
  "protein",
  "calcium",
  "iron",
  "potassium",
  "vitamin_d",
  "magnesium",
  "zinc",
  "selenium",
  "vitamin_a",
  "vitamin_e",
  "vitamin_k",
  "vitamin_c",
  "vitamin_b6",
  "vitamin_b12",
  "folate",
];

/**
 * Package-label nutrition override — a compact, collapsed-by-default
 * disclosure so the ~3,000 non-food products that will never use it don't pay
 * for it visually. Serving grams gates the rest: entering it is what turns
 * "no label" into a label with data (see `LabelNutritionFormValue`), so the
 * source note and nutrient grid only appear once it has a value.
 *
 * Takes the already-narrowed `labelNutrition` paths (not the full
 * `ProductFormFieldPaths`) so the field is guaranteed present here — the
 * caller only mounts this when `paths.labelNutrition` exists at all (some
 * forms, like the compact quick-inventory-add create form, have no
 * label-nutrition field of their own).
 */
function LabelNutritionFields<TFieldValues extends ProductFormFieldValues>({
  form,
  paths,
}: Pick<ProductFormSectionProps<TFieldValues>, "form"> & {
  paths: NonNullable<ProductFormFieldPaths<TFieldValues>["labelNutrition"]>;
}) {
  const [open, setOpen] = useState(
    () => form.getValues(paths.servingGrams) != null,
  );
  const servingGrams = useWatch({
    control: form.control,
    name: paths.servingGrams,
  });
  const hasServing = servingGrams != null;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger
        render={
          <Row
            as="button"
            type="button"
            align="center"
            gap="sm"
            className="w-full rounded-md px-2 py-1 text-sm text-muted-foreground hover:bg-accent"
          />
        }
      >
        <ChevronRight
          className={`size-4 transition-transform ${open ? "rotate-90" : ""}`}
          aria-hidden
        />
        <span>Package label{hasServing ? "" : " (Optional)"}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <Stack gap="sm" className="pt-2">
          <NullableNumericField
            form={form}
            step="1"
            name={paths.servingGrams}
            label="Serving size, as printed (g)"
            placeholder="e.g. 44"
          />
          {hasServing && (
            <>
              <UnifiedTextField
                form={form}
                name={paths.source}
                label="Source (Optional)"
                placeholder="e.g. Hero package label"
                nullable={true}
              />
              <div className="grid grid-cols-2 gap-x-3 gap-y-1 sm:grid-cols-3">
                {LABEL_NUTRIENT_ORDER.map((key) => {
                  const info = TIER1_NUTRIENTS[key];
                  return (
                    <NullableNumericField
                      key={key}
                      form={form}
                      step="0.1"
                      name={paths.nutrient(key)}
                      label={`${info.displayName} (${info.unit.toLowerCase()})`}
                      placeholder="0"
                    />
                  );
                })}
              </div>
            </>
          )}
        </Stack>
      </CollapsibleContent>
    </Collapsible>
  );
}

function ProductCommerceFields<TFieldValues extends ProductFormFieldValues>({
  form,
  paths,
  compact,
  hidePrice,
  nameValue,
  upcValue,
  fdcValue,
  onUsdaSelect,
  lookupImageUrl,
  isLookingUp,
  onUpcLookup,
}: ProductFormSectionProps<TFieldValues> & {
  hidePrice: boolean;
  nameValue: string;
  upcValue: string | null;
  fdcValue: number | null;
  onUsdaSelect: (food: FoodSummaryWithLinkedProducts) => void;
  lookupImageUrl: string | null;
  isLookingUp: boolean;
  onUpcLookup: () => void;
}) {
  // SAFETY: RHF's `FieldErrors` type for a nested object field resolves to an
  // unwieldy generic-conditional shape while `TFieldValues` is still generic
  // here; at any concrete instantiation this is a plain `FieldError` with an
  // optional `message` — the shape `FieldError` (the component) expects.
  const labelNutritionError = form.formState.errors.labelNutrition as
    | { message?: string }
    | undefined;

  return (
    <>
      <FormSection title="Quantity & price" compact={compact}>
        <SideBySideFields>
          <NullableNumericField
            form={form}
            step="1"
            name={paths.expectedQuantity}
            label={
              hidePrice
                ? compact
                  ? "Expected Qty"
                  : "Expected Quantity (1 for unique items)"
                : "Expected Quantity (1 for unique items)"
            }
            placeholder={
              hidePrice
                ? compact
                  ? "Unlimited"
                  : "Leave empty for unlimited"
                : "Leave empty for unlimited"
            }
          />
          <NullableNumericField
            form={form}
            step={hidePrice ? "1" : "0.01"}
            name={hidePrice ? paths.fdcId : paths.price}
            label={
              hidePrice
                ? compact
                  ? "FDC ID"
                  : "USDA FDC ID (Optional)"
                : "Price Override per Item"
            }
            placeholder={
              hidePrice
                ? compact
                  ? "FDC id"
                  : "set via USDA search above"
                : "Leave empty to derive from expenses"
            }
            {...(!hidePrice && { prefix: "$" })}
          />
        </SideBySideFields>
      </FormSection>

      <FormSection title="Identifiers" compact={compact}>
        <SideBySideFields>
          <UnifiedTextField
            form={form}
            name={paths.isbn}
            label="ISBN (Optional)"
            placeholder="ISBN-10 or ISBN-13"
            nullable={true}
          />
          <ProductUpcField
            form={form}
            paths={paths}
            upcValue={upcValue}
            lookupImageUrl={lookupImageUrl}
            isLookingUp={isLookingUp}
            onLookup={onUpcLookup}
          />
        </SideBySideFields>
      </FormSection>

      <FormSection title="USDA & nutrition" compact={compact}>
        {!compact && (
          <UsdaFoodSearchField
            initialQuery={nameValue}
            onSelect={onUsdaSelect}
          />
        )}
        {!hidePrice && (
          <NullableNumericField
            form={form}
            step="1"
            name={paths.fdcId}
            label="USDA FDC ID (Optional)"
            placeholder="set via USDA search above"
          />
        )}
        {/* An explicit FDC id takes precedence over UPC auto-resolution, so
            surface which product-to-food link is active. */}
        {(upcValue || fdcValue) && (
          <Description size="xs">
            USDA link: {fdcValue ? "via FDC id (explicit)" : "via UPC (auto)"}
          </Description>
        )}
        {paths.labelNutrition && (
          <>
            <LabelNutritionFields form={form} paths={paths.labelNutrition} />
            {/* The resolver's `labelNutritionField` refine (≥1 nutrient once
                serving grams is set) attaches its issue to the whole field —
                surface it here rather than let it fail the submit silently. */}
            <FieldError errors={[labelNutritionError]} />
          </>
        )}
      </FormSection>

      <FormSection title="Ingredient" compact={compact}>
        <ComboboxFieldWithSearch
          form={form}
          name={paths.ingredient}
          label="Linked ingredient"
          searchType="ingredient"
        />
      </FormSection>
    </>
  );
}

function ProductMediaFields<TFieldValues extends ProductFormFieldValues>({
  imageHandlers,
  existingImages,
  existingDocuments,
  documentFolder,
  pendingImages,
  identityForm,
  compact,
}: Pick<
  ProductFormFieldsProps<TFieldValues>,
  | "imageHandlers"
  | "existingImages"
  | "existingDocuments"
  | "documentFolder"
  | "compact"
> & {
  pendingImages: PendingImage[];
  identityForm: Parameters<typeof IdentifyProductButton>[0]["form"];
}) {
  // A just-removed existing image is client-side only until save — keep it
  // out of the identify read set so the button doesn't ask the model to read
  // a photo the operator is in the middle of detaching.
  const identifiableExistingImages = useMemo(
    () =>
      (existingImages ?? EMPTY_PENDING_IMAGES).filter(
        (image) => !imageHandlers.removedImageIds.includes(image.id),
      ),
    [existingImages, imageHandlers.removedImageIds],
  );
  return (
    <Stack gap="sm">
      <PendingImageUpload
        entityType="PRODUCT"
        onImagesChange={imageHandlers.handlePendingImagesChange}
        existingImages={existingImages}
        onExistingImagesRemove={imageHandlers.handleRemovedImagesChange}
        onExistingImagesPurposeChange={
          imageHandlers.handleExistingImagePurposesChange
        }
      />
      {/* Unconditional: the button disables itself and says why. Gating it
          here is what made the affordance vanish, so nobody learned that a
          photo unlocks it. */}
      <IdentifyProductButton
        form={identityForm}
        existingImages={identifiableExistingImages}
        pendingImages={pendingImages}
      />
      {!compact && (
        <PendingDocumentUpload
          entityType="PRODUCT"
          folder={documentFolder}
          onDocumentsChange={imageHandlers.handlePendingDocumentsChange}
          existingDocuments={existingDocuments}
          onExistingDocumentsRemove={imageHandlers.handleRemovedDocumentsChange}
        />
      )}
    </Stack>
  );
}

function ProductUnitMappings<TFieldValues extends ProductFormFieldValues>({
  form,
  paths,
}: Pick<ProductFormSectionProps<TFieldValues>, "form" | "paths">) {
  return (
    <ArrayFieldManager<UnitMappingInput, TFieldValues>
      form={form}
      name={paths.unitMappings}
      title="Unit conversions"
      addButtonText="Add conversion"
      emptyValue={{
        a: { value: 1, unit: "" },
        b: { value: 1, unit: "" },
        source: null,
      }}
    >
      {(_, index) => {
        const mappingPaths = paths.unitMapping(index);
        return (
          <UnitMappingPairField
            form={form}
            valueAPath={mappingPaths.valueA}
            unitAPath={mappingPaths.unitA}
            valueBPath={mappingPaths.valueB}
            unitBPath={mappingPaths.unitB}
            sourcePath={mappingPaths.source}
            showSource
          />
        );
      }}
    </ArrayFieldManager>
  );
}

function ProductExternalIds<TFieldValues extends ProductFormFieldValues>({
  form,
  paths,
}: Pick<ProductFormSectionProps<TFieldValues>, "form" | "paths">) {
  const identityWatch = useWatch({
    control: form.control,
    name: [paths.name, paths.manufacturer],
  });
  const productName = basisValueOf(identityWatch[0]);
  const manufacturer = basisValueOf(identityWatch[1]);
  if (!paths.externalIds || !paths.externalId) return null;
  return (
    <ArrayFieldManager<ExternalIdInput, TFieldValues>
      form={form}
      name={paths.externalIds}
      title="External IDs"
      addButtonText="Add External ID"
      emptyValue={{
        source: "",
        kind: "legacy_unspecified",
        externalId: "",
        url: undefined,
      }}
    >
      {(_, index) => {
        const externalIdPaths = paths.externalId?.(index);
        if (!externalIdPaths) return null;
        return (
          <>
            <div className="min-w-[8rem] flex-1">
              <SelectField
                form={form}
                name={externalIdPaths.kind}
                label="Kind"
                options={externalIdKind.options.map((kind) => ({
                  value: kind,
                  label: kind.replaceAll("_", " "),
                }))}
              />
              <ExternalIdKindSuggestion
                form={form}
                kindPath={externalIdPaths.kind}
                sourcePath={externalIdPaths.source}
                externalIdPath={externalIdPaths.externalId}
                urlPath={externalIdPaths.url}
                productName={productName}
                manufacturer={manufacturer}
              />
            </div>
            <div className="min-w-[8rem] flex-1">
              <UnifiedTextField
                form={form}
                name={externalIdPaths.source}
                label="Source"
                placeholder="e.g. amazon, mcmaster"
              />
            </div>
            <div className="min-w-[8rem] flex-1">
              <UnifiedTextField
                form={form}
                name={externalIdPaths.externalId}
                label="Identifier"
                placeholder="e.g. B08N5WRWNW"
              />
            </div>
            <div className="min-w-[10rem] flex-1">
              <UnifiedTextField
                form={form}
                name={externalIdPaths.url}
                label="URL"
                placeholder="https://..."
                nullable={true}
              />
            </div>
          </>
        );
      }}
    </ArrayFieldManager>
  );
}

/**
 * Standalone product form fields component.
 * Renders all product-related fields (name, model, notes, manufacturer, category,
 * UPC, price, fdc_id, ingredient, images, unit mappings).
 *
 * Used by both ProductForm (full form) and QuickInventoryAdd (inline create mode).
 */
export function ProductFormFields<TFieldValues extends ProductFormFieldValues>({
  mode,
  form,
  paths,
  imageHandlers,
  existingImages = EMPTY_PENDING_IMAGES,
  existingDocuments,
  documentFolder,
  pendingImages = EMPTY_PENDING_IMAGES,
  hideNameField = false,
  hidePrice = false,
  compact = false,
}: ProductFormFieldsProps<TFieldValues>) {
  const [lookupImageUrl, setLookupImageUrl] = useState<string | null>(null);
  const [isLookingUp, setIsLookingUp] = useState(false);
  const identityForm = {
    setValue: (update: {
      field: "name" | "manufacturer" | "model";
      value: string;
    }) => {
      switch (update.field) {
        case "name":
          setProductField(form, paths.name, update.value);
          return;
        case "manufacturer":
          setProductField(form, paths.manufacturer, update.value);
          return;
        case "model":
          setProductField(form, paths.model, update.value);
      }
    },
  };

  // Watch fields for conditional rendering
  const observedFields = observedProductFieldsSchema.parse(form.watch());
  const { name: nameValue, fdc_id: fdcValue, upc: upcValue } = observedFields;
  const isMisc = isMiscProduct(nameValue);

  const handleUpcLookup = async () => {
    const upcValue = observedProductFieldsSchema.parse(form.getValues()).upc;
    if (!upcValue) return;

    setIsLookingUp(true);
    try {
      const result = await upc.lookup.call({ upc: upcValue });
      if (result) {
        if (result.name) {
          setProductField(form, paths.name, result.name);
        }
        if (result.manufacturer) {
          setProductField(form, paths.manufacturer, result.manufacturer);
        } else if (result.brand) {
          setProductField(form, paths.manufacturer, result.brand);
        }
        if (result.priceDollars) {
          setProductField(form, paths.price, result.priceDollars);
        }
        if (result.imageUrl) {
          setLookupImageUrl(result.imageUrl);
        }
      }
    } catch (err) {
      showErrorToast(err, "UPC lookup failed");
    } finally {
      setIsLookingUp(false);
    }
  };

  // Pick a USDA food by name → store its fdc_id (the universal link, works for
  // any food type). The linked food then supplies nutrition + portion
  // conversions at read time, so we don't store those mappings. We deliberately
  // don't touch `upc` — that's the product's own barcode, not the food's.
  const handleUsdaSelect = (food: FoodSummaryWithLinkedProducts) => {
    setProductField(form, paths.fdcId, food.fdc_id);
    const currentName = observedProductFieldsSchema.parse(
      form.getValues(),
    ).name;
    if (!currentName) {
      setProductField(form, paths.name, food.foodInfo.description ?? "");
    }
  };

  const content = (
    <>
      <ProductDetailsFields
        mode={mode}
        form={form}
        paths={paths}
        compact={compact}
        hideNameField={hideNameField}
        isMisc={isMisc}
      />

      <ProductTagFields form={form} compact={compact} />

      {!isMisc && (
        <ProductCommerceFields
          form={form}
          paths={paths}
          compact={compact}
          hidePrice={hidePrice}
          nameValue={nameValue}
          upcValue={upcValue}
          fdcValue={fdcValue}
          onUsdaSelect={handleUsdaSelect}
          lookupImageUrl={lookupImageUrl}
          isLookingUp={isLookingUp}
          onUpcLookup={handleUpcLookup}
        />
      )}

      <ProductMediaFields
        imageHandlers={imageHandlers}
        existingImages={existingImages}
        existingDocuments={existingDocuments}
        documentFolder={documentFolder}
        pendingImages={pendingImages}
        identityForm={identityForm}
        compact={compact}
      />

      {!isMisc && <ProductUnitMappings form={form} paths={paths} />}

      <ProductExternalIds form={form} paths={paths} />
    </>
  );

  if (compact) {
    return (
      <Stack className="border border-border/50 bg-muted/30 p-4">
        {content}
      </Stack>
    );
  }

  // Extra spacing between the labeled sections so the form reads as groups.
  return <Stack>{content}</Stack>;
}
