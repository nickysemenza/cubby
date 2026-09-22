import {
  type ExternalIdInput,
  externalIdKind,
} from "@cubby/schemas/external-id";
import { imageOut, partitionEntityFiles } from "@cubby/schemas/image";
import type { UnitMappingInput } from "@cubby/schemas/unitmapping";
import type { FoodSummaryWithLinkedProducts } from "@cubby/schemas/usda";
import {
  collectionSlugsFromTags,
  collectionTagFromSlug,
  isCollectionTag,
  normalizeCollectionSlug,
} from "@cubby/shared/collection-tag";
import { redundantTokens } from "@cubby/shared/redundant-tokens";
import { type NutrientKey, TIER1_NUTRIENTS } from "@cubby/usda-schemas";
import { ChevronRight, Search } from "lucide-react";
import { type MutableRefObject, useMemo, useRef, useState } from "react";
import {
  type FieldValues,
  type UseFormReturn,
  useWatch,
} from "react-hook-form";
import { z } from "zod";

import { basisValueOf } from "~/app/_components/ai/field-suggestion";
import { UsdaFoodSearchField } from "~/app/_components/combobox/with-usda-food-search";
import {
  NullableNumericField,
  SelectField,
  UnifiedTextField,
} from "~/app/_components/form-utils";
import { ChipsInput } from "~/app/_components/forms/chips-input";
import { FormFieldGroup } from "~/app/_components/forms/form-field-group";
import { useProductCategories } from "~/app/_components/hooks/useProductCategories";
import { PendingDocumentUpload } from "~/app/_components/PendingDocumentUpload";
import type { PendingImage } from "~/app/_components/PendingImageUpload";
import { ExternalIdKindSuggestion } from "~/app/_components/products/external-id-kind-suggestion";
import { IdentifyProductButton } from "~/app/_components/products/identify-product-with-ai";
import { UnitMappingPairField } from "~/app/_components/units/unit-mapping-pair-field";
import { showErrorToast } from "~/components/feedback/error-details";
import { ArrayFieldManager } from "~/components/forms/array-field-manager";
import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "~/components/ui/collapsible";
import { Description } from "~/components/ui/description";
import { FieldError } from "~/components/ui/field";
import { Image } from "~/components/ui/image";
import { Spinner } from "~/components/ui/spinner";
import { upc as upcLookup } from "~/lib/upc.functions";

import type {
  EntityEditorMediaInput,
  EntityEditorMediaOutput,
} from "./editor-presentations";
import type { SpecializedIntentRendererProps } from "./entity-primitive-fields";
import type { EntityEditRecord } from "./types";

/**
 * `product.tags` split into two chip inputs — real compatibility tags and
 * Collections (`collection:*` entries), merged back into the one stored
 * `tags` column on every change. Replaces the retired `collections`
 * pseudo-field from `product-form.tsx`: there is no editor-only field here,
 * just a presentation split over one real field.
 */
export function ProductTagsField({
  form,
  field,
}: SpecializedIntentRendererProps) {
  const [manufacturer, aliases, categoryId] = useWatch({
    control: form.control,
    name: ["manufacturer", "aliases", "categoryId"],
  });
  const { categories } = useProductCategories();
  const category = useMemo(
    () =>
      categories.find((candidate) => candidate.id === basisValueOf(categoryId)),
    [categories, categoryId],
  );
  const raw = useWatch({ control: form.control, name: field.key });
  const value = z.array(z.string()).catch([]).parse(raw);
  const tags = value.filter((tag) => !isCollectionTag(tag));
  const collections = collectionSlugsFromTags(value);
  const redundant = useMemo(
    () =>
      new Map(
        redundantTokens({
          values: tags,
          restating: {
            manufacturer: basisValueOf(manufacturer),
            classification: category?.path.map((node) => node.name),
            feature: category?.feature ?? null,
            alias: z.array(z.string()).catch([]).parse(aliases),
          },
        }).map((match) => [match.value, match]),
      ),
    [tags, manufacturer, category, aliases],
  );
  const write = (nextTags: string[], nextCollections: string[]) =>
    form.setValue(
      field.key,
      [...nextTags, ...nextCollections.map(collectionTagFromSlug)],
      { shouldDirty: true },
    );
  return (
    <Stack gap="sm">
      <FormFieldGroup label="Tags">
        <ChipsInput
          value={tags}
          onChange={(next) => write(next, collections)}
          placeholder="e.g. grinder-4.5in, M18"
          chipClassName={(tag) =>
            redundant.has(tag) ? "border-warning text-warning-ink" : undefined
          }
          renderChip={(tag) => {
            const match = redundant.get(tag);
            return (
              <span
                title={
                  match
                    ? `Restates ${match.reason}: ${match.matched}`
                    : undefined
                }
              >
                {tag}
              </span>
            );
          }}
        />
      </FormFieldGroup>
      <FormFieldGroup label="Collections">
        <ChipsInput
          value={collections}
          onChange={(next) =>
            write(
              tags,
              next.map(normalizeCollectionSlug).filter((slug) => slug !== ""),
            )
          }
          placeholder="e.g. painting"
        />
      </FormFieldGroup>
    </Stack>
  );
}

/**
 * `product.unitMappings`: the "A = B" conversion/price-edge editor, ported
 * from the retired `ProductUnitMappings`. Row `id`s round-trip through
 * `FieldOptions.initial` (`definitions.ts`) so resending an untouched row
 * updates it in place instead of delete+recreate — the same MCP contract
 * `find/get/list` document for `unitMappings[].id`.
 */
export function ProductUnitMappingsField({
  form,
  field,
}: SpecializedIntentRendererProps) {
  return (
    <ArrayFieldManager<UnitMappingInput>
      form={form}
      name={field.key}
      title="Unit conversions"
      addButtonText="Add conversion"
      emptyValue={{
        a: { value: 1, unit: "" },
        b: { value: 1, unit: "" },
        source: null,
      }}
    >
      {(_, index) => (
        <UnitMappingPairField
          form={form}
          valueAPath={`${field.key}.${index}.a.value`}
          unitAPath={`${field.key}.${index}.a.unit`}
          valueBPath={`${field.key}.${index}.b.value`}
          unitBPath={`${field.key}.${index}.b.unit`}
          sourcePath={`${field.key}.${index}.source`}
          showSource
        />
      )}
    </ArrayFieldManager>
  );
}

/**
 * `product.externalIds`: the array-of-object grid (PR 2's `ArrayFieldManager
 * columns` mode) plus PR 1's Jev kind suggestion under the Kind select. Row
 * controls pass `label=""` — the grid's own header row is the label, per the
 * `columns` contract (`array-field-manager.tsx`).
 */
export function ProductExternalIdsField({
  form,
  field,
}: SpecializedIntentRendererProps) {
  const [productName, manufacturer] = useWatch({
    control: form.control,
    name: ["name", "manufacturer"],
  });
  return (
    <ArrayFieldManager<ExternalIdInput>
      form={form}
      name={field.key}
      title="External IDs"
      addButtonText="Add external ID"
      emptyValue={{
        source: "",
        kind: "legacy_unspecified",
        externalId: "",
        url: undefined,
      }}
      columns={[
        { label: "Kind", className: "min-w-[8rem] flex-1" },
        { label: "Source", className: "min-w-[8rem] flex-1" },
        { label: "Identifier", className: "min-w-[8rem] flex-1" },
        { label: "URL", className: "min-w-[10rem] flex-1" },
      ]}
    >
      {(_, index) => {
        const kindPath = `${field.key}.${index}.kind`;
        const sourcePath = `${field.key}.${index}.source`;
        const externalIdPath = `${field.key}.${index}.externalId`;
        const urlPath = `${field.key}.${index}.url`;
        return (
          <>
            <div className="min-w-[8rem] flex-1">
              <SelectField
                form={form}
                name={kindPath}
                label=""
                options={externalIdKind.options.map((kind) => ({
                  value: kind,
                  label: kind.replaceAll("_", " "),
                }))}
              />
              <ExternalIdKindSuggestion
                form={form}
                kindPath={kindPath}
                sourcePath={sourcePath}
                externalIdPath={externalIdPath}
                urlPath={urlPath}
                productName={basisValueOf(productName)}
                manufacturer={basisValueOf(manufacturer)}
              />
            </div>
            <div className="min-w-[8rem] flex-1">
              <UnifiedTextField
                form={form}
                name={sourcePath}
                label=""
                placeholder="e.g. amazon, mcmaster"
              />
            </div>
            <div className="min-w-[8rem] flex-1">
              <UnifiedTextField
                form={form}
                name={externalIdPath}
                label=""
                placeholder="e.g. B08N5WRWNW"
              />
            </div>
            <div className="min-w-[10rem] flex-1">
              <UnifiedTextField
                form={form}
                name={urlPath}
                label=""
                placeholder="https://..."
                nullable
              />
            </div>
          </>
        );
      }}
    </ArrayFieldManager>
  );
}

/** `product.upc`: the barcode text field plus a "Lookup" action that fills
 * name/manufacturer/price from the UPC worker — ported from the retired
 * `ProductUpcField`. Writes straight to the sibling `name`/`manufacturer`/
 * `price` fields, the same paths the generic editor already renders them at. */
export function ProductUpcField({
  form,
  field,
}: SpecializedIntentRendererProps) {
  const [lookupImageUrl, setLookupImageUrl] = useState<string | null>(null);
  const [isLookingUp, setIsLookingUp] = useState(false);
  const upcValue = z
    .string()
    .nullable()
    .catch(null)
    .parse(useWatch({ control: form.control, name: field.key }));

  const handleLookup = async () => {
    if (!upcValue) return;
    setIsLookingUp(true);
    try {
      const result = await upcLookup.lookup.call({ upc: upcValue });
      if (result) {
        if (result.name)
          form.setValue("name", result.name, { shouldDirty: true });
        if (result.manufacturer) {
          form.setValue("manufacturer", result.manufacturer, {
            shouldDirty: true,
          });
        } else if (result.brand) {
          form.setValue("manufacturer", result.brand, { shouldDirty: true });
        }
        if (result.priceDollars) {
          form.setValue("price", result.priceDollars, { shouldDirty: true });
        }
        if (result.imageUrl) setLookupImageUrl(result.imageUrl);
      }
    } catch (err) {
      showErrorToast(err, "UPC lookup failed");
    } finally {
      setIsLookingUp(false);
    }
  };

  return (
    <Stack gap="sm">
      <Row align="end" gap="sm">
        <div className="flex-1">
          <UnifiedTextField
            form={form}
            name={field.key}
            label={field.label}
            placeholder="12-digit UPC code"
            nullable
          />
        </div>
        <Button
          type="button"
          variant="outline"
          onClick={() => void handleLookup()}
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

/** `product.fdc_id`: a USDA name search (sets `fdc_id` and, when the name is
 * still blank, `name`) plus the raw FDC id field — ported from the retired
 * `UsdaFoodSearchField` wiring in `ProductCommerceFields`. */
export function ProductUsdaFoodField({
  form,
  field,
}: SpecializedIntentRendererProps) {
  const [name, fdcValue, upcValue] = useWatch({
    control: form.control,
    name: ["name", field.key, "upc"],
  });
  const handleSelect = (food: FoodSummaryWithLinkedProducts) => {
    form.setValue(field.key, food.fdc_id, { shouldDirty: true });
    if (!basisValueOf(name)) {
      form.setValue("name", food.foodInfo.description ?? "", {
        shouldDirty: true,
      });
    }
  };
  return (
    <Stack gap="sm">
      <UsdaFoodSearchField
        initialQuery={basisValueOf(name) ?? undefined}
        onSelect={handleSelect}
      />
      <NullableNumericField
        form={form}
        step="1"
        name={field.key}
        label={field.label}
        placeholder="set via USDA search above"
      />
      {(basisValueOf(upcValue) || basisValueOf(fdcValue)) && (
        <Description size="xs">
          USDA link:{" "}
          {basisValueOf(fdcValue) ? "via FDC id (explicit)" : "via UPC (auto)"}
        </Description>
      )}
    </Stack>
  );
}

// FDA Nutrition Facts label order: the macro block, then `TIER1_NUTRIENTS`'
// own grouping — matches `NutritionLabel`'s `ROW_ORDER` so the read and edit
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
 * `product.labelNutrition`: a package-label nutrition override, collapsed by
 * default — serving grams gates the rest (see the draft/stored split in
 * `definitions.ts`). Ported from the retired `LabelNutritionFields`, at
 * `field.key`-rooted paths instead of a caller-supplied `paths` prop.
 */
export function ProductLabelNutritionField({
  form,
  field,
}: SpecializedIntentRendererProps) {
  const servingPath = `${field.key}.servingGrams`;
  const sourcePath = `${field.key}.source`;
  const [open, setOpen] = useState(() => form.getValues(servingPath) != null);
  const servingGrams = useWatch({ control: form.control, name: servingPath });
  const hasServing = servingGrams != null;
  // SAFETY: `formState.errors[field.key]` is a plain `FieldError` for this
  // whole-object field (the kernel's `validate` attaches it to `field.key`
  // directly, see `productLabelNutritionValidate`), not a nested error tree.
  const labelNutritionError = form.formState.errors[field.key] as
    | { message?: string }
    | undefined;

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
        <span>Package label{hasServing ? "" : " (optional)"}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <Stack gap="sm" className="pt-2">
          <NullableNumericField
            form={form}
            step="1"
            name={servingPath}
            label="Serving size, as printed (g)"
            placeholder="e.g. 44"
          />
          {hasServing && (
            <>
              <UnifiedTextField
                form={form}
                name={sourcePath}
                label="Source"
                placeholder="e.g. Hero package label"
                nullable
              />
              <div className="grid grid-cols-2 gap-x-3 gap-y-1 sm:grid-cols-3">
                {LABEL_NUTRIENT_ORDER.map((key) => {
                  const info = TIER1_NUTRIENTS[key];
                  return (
                    <NullableNumericField
                      key={key}
                      form={form}
                      step="0.1"
                      name={`${field.key}.nutrients.${key}`}
                      label={`${info.displayName} (${info.unit.toLowerCase()})`}
                      placeholder="0"
                    />
                  );
                })}
              </div>
            </>
          )}
          <FieldError errors={[labelNutritionError]} />
        </Stack>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** The form port `IdentifyProductButton` accepts — see its own `form` prop. */
interface ProductIdentityFormPort {
  setValue(update: {
    field: "name" | "manufacturer" | "model";
    value: string;
  }): void;
}

/**
 * `IdentifyProductButton` reads name/manufacturer/model off the form through
 * a small port, the same shape the retired `product-form-fields.tsx` used.
 */
function productIdentityFormPort(
  form: UseFormReturn<FieldValues>,
): ProductIdentityFormPort {
  return {
    setValue: (update) =>
      form.setValue(update.field, update.value, { shouldDirty: true }),
  };
}

/**
 * The product `media` hook's `actions` slot: a just-removed existing image
 * is client-only until save, so it stays out of the identify read set —
 * otherwise the model would be asked to read a photo the operator is mid-
 * detaching (the regression `IdentifyProductButton`'s own doc comment names).
 */
function ProductIdentifyAction({
  form,
  existingImages,
  pendingImages,
}: {
  form: UseFormReturn<FieldValues>;
  existingImages: readonly PendingImage[];
  pendingImages: readonly PendingImage[];
}) {
  const removedImageIds = z
    .array(z.string())
    .catch([])
    .parse(useWatch({ control: form.control, name: "removeImageIds" }));
  const identifiable = existingImages.filter(
    (image) => !removedImageIds.includes(image.id),
  );
  return (
    <IdentifyProductButton
      form={productIdentityFormPort(form)}
      existingImages={[...identifiable]}
      pendingImages={[...pendingImages]}
    />
  );
}

const attachedImageWithContentType = imageOut.extend({
  purpose: z.enum(["item", "label"]).nullable(),
});
const asPendingImage = (image: {
  id: string;
  url: string;
  filename: string;
  key: string;
  purpose: "item" | "label" | null;
}): PendingImage =>
  image.purpose
    ? {
        id: image.id,
        url: image.url,
        filename: image.filename,
        key: image.key,
        purpose: image.purpose,
      }
    : {
        id: image.id,
        url: image.url,
        filename: image.filename,
        key: image.key,
      };

/**
 * The product `media` hook's `documents` slot: manuals share the Product
 * `images` relation with item/label photos, distinguished only by content
 * type (`partitionEntityFiles`) — they can live in either `record.images` or
 * `record.labelImages`. Its uploads/removals write into the shared
 * `pendingImageIds`/`removeImageIds` the image block owns, merging rather
 * than overwriting (`entity-edit-dialog-content.tsx`'s own matching merge on
 * the image side) — each writer tracks and replaces only the slice of the
 * shared array it previously contributed.
 */
function ProductManualsField({
  form,
  record,
}: {
  form: UseFormReturn<FieldValues>;
  record?: EntityEditRecord;
}) {
  // `EntityEditRecord.id` is always a string; no narrowing needed.
  const documentFolder = record?.id;
  const existingDocuments = useMemo(() => {
    const images = z
      .array(attachedImageWithContentType)
      .catch([])
      .parse(record?.images);
    const labelImages = z
      .array(attachedImageWithContentType)
      .catch([])
      .parse(record?.labelImages);
    return partitionEntityFiles([...images, ...labelImages]).documents.map(
      (document) => ({ ...asPendingImage(document), size: undefined }),
    );
  }, [record]);
  const ownPendingDocumentIds = useRef<readonly string[]>([]);
  const ownRemovedDocumentIds = useRef<readonly string[]>([]);
  const merge = (
    fieldKey: "pendingImageIds" | "removeImageIds",
    owned: MutableRefObject<readonly string[]>,
    nextOwnIds: readonly string[],
  ) => {
    const current = z
      .array(z.string())
      .catch([])
      .parse(form.getValues(fieldKey));
    const foreign = current.filter((id) => !owned.current.includes(id));
    owned.current = nextOwnIds;
    form.setValue(fieldKey, [...new Set([...foreign, ...nextOwnIds])], {
      shouldDirty: true,
    });
  };
  return (
    <PendingDocumentUpload
      entityType="PRODUCT"
      folder={documentFolder}
      existingDocuments={existingDocuments}
      onDocumentsChange={(documents) =>
        merge(
          "pendingImageIds",
          ownPendingDocumentIds,
          documents.map((document) => document.id),
        )
      }
      onExistingDocumentsRemove={(removedIds) =>
        merge("removeImageIds", ownRemovedDocumentIds, removedIds)
      }
    />
  );
}

/**
 * Product's `EntityEditorPresentation.media` hook: `IdentifyProductButton`
 * as `actions`, `record.labelImages`' displayable images merged into the
 * gallery as `extraExistingImages`, and the manuals dropzone as `documents`.
 */
export function productMedia({
  form,
  record,
  pendingImages,
  existingImages,
}: EntityEditorMediaInput): EntityEditorMediaOutput {
  const labelImages = z
    .array(attachedImageWithContentType)
    .catch([])
    .parse(record?.labelImages);
  const extraExistingImages =
    partitionEntityFiles(labelImages).images.map(asPendingImage);
  return {
    actions: (
      <ProductIdentifyAction
        form={form}
        existingImages={existingImages}
        pendingImages={pendingImages}
      />
    ),
    extraExistingImages,
    documents: <ProductManualsField form={form} record={record} />,
  };
}
