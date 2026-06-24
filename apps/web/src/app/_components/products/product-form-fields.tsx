import type { FoodSummaryWithLinkedProducts } from "@cubby/schemas/combo";
import type { ExternalIdInput } from "@cubby/schemas/external-id";
import type { IngredientId } from "@cubby/schemas/identifiers";
import { hasFoodIndicators } from "@cubby/schemas/product";
import type { UnitMappingInput } from "@cubby/schemas/unitmapping";
import { isMiscProduct } from "@cubby/shared";
import { Search } from "lucide-react";
import { type ReactNode, useState } from "react";
import type { FieldValues, Path, UseFormReturn } from "react-hook-form";
import { ArrayFieldManager } from "~/components/forms/array-field-manager";
import { Button } from "~/components/ui/button";
import { Card, CardContent } from "~/components/ui/card";
import { Image } from "~/components/ui/image";
import { sectionRuleClass } from "~/components/ui/section-rule";
import { Spinner } from "~/components/ui/spinner";
import type { useImageState } from "~/hooks/useImageState";
import { cn } from "~/lib/utils";
import { useTRPCClient } from "~/trpc/react";
import { UsdaFoodSearchField } from "../combobox/with-usda-food-search";
import {
  ComboboxFieldWithSearch,
  NullableNumericField,
  SideBySideFields,
  UnifiedTextField,
} from "../form-utils";
import { type PendingImage, PendingImageUpload } from "../PendingImageUpload";
import { UnitMappingPairField } from "../units/unit-mapping-pair-field";
import { CategoryFieldWithAI } from "./category-field-with-ai";
import { IdentifyProductButton } from "./identify-product-with-ai";

const EMPTY_PENDING_IMAGES: PendingImage[] = [];

/**
 * Visual grouping for the product form. In `compact` mode (QuickInventoryAdd) it
 * renders children flat — the compact card is already small. In the full form it
 * adds a ledger eyebrow header, or — for the vitals group — a chunky spec plate
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
    <section className="space-y-2">
      <h4 className={cn(sectionRuleClass, "eyebrow my-0 font-medium")}>
        {title}
      </h4>
      {children}
    </section>
  );
}

type ImageHandlers = Pick<
  ReturnType<typeof useImageState>,
  "handlePendingImagesChange" | "handleRemovedImagesChange"
>;

interface ProductFormFieldsProps<TFieldValues extends FieldValues> {
  form: UseFormReturn<TFieldValues>;
  imageHandlers: ImageHandlers;
  existingImages?: PendingImage[];
  /** Pending images for AI product identification */
  pendingImages?: PendingImage[];
  /** When true, skips the Name+Model SideBySideFields row */
  hideNameField?: boolean;
  /** When true, skips the Price field (rendered by parent instead) */
  hidePrice?: boolean;
  /** When true, wraps fields in a muted card and reduces heading sizes */
  compact?: boolean;
}

/**
 * Standalone product form fields component.
 * Renders all product-related fields (name, model, notes, manufacturer, category,
 * UPC, price, fdc_id, ingredient, images, unit mappings).
 *
 * Used by both ProductForm (full form) and QuickInventoryAdd (inline create mode).
 */
export function ProductFormFields<TFieldValues extends FieldValues>({
  form,
  imageHandlers,
  existingImages = EMPTY_PENDING_IMAGES,
  pendingImages = EMPTY_PENDING_IMAGES,
  hideNameField = false,
  hidePrice = false,
  compact = false,
}: ProductFormFieldsProps<TFieldValues>) {
  const [lookupImageUrl, setLookupImageUrl] = useState<string | null>(null);
  const [isLookingUp, setIsLookingUp] = useState(false);
  const trpcClient = useTRPCClient();

  // Watch fields for conditional rendering
  const nameValue = form.watch("name" as Path<TFieldValues>) as string;
  const manufacturerValue = form.watch(
    "manufacturer" as Path<TFieldValues>,
  ) as string;
  const fdcValue = form.watch("fdc_id" as Path<TFieldValues>) as number | null;
  const upcValue = form.watch("upc" as Path<TFieldValues>) as string | null;
  const ingredientValue = form.watch("ingredient" as Path<TFieldValues>) as {
    id?: IngredientId;
  } | null;

  const isMisc = isMiscProduct(nameValue);
  const isFoodForced = hasFoodIndicators({
    fdc_id: fdcValue,
    ingredientId: ingredientValue?.id,
  });

  const handleUpcLookup = async () => {
    const upcValue = form.getValues("upc" as Path<TFieldValues>) as
      | string
      | null;
    if (!upcValue) return;

    setIsLookingUp(true);
    try {
      const result = await trpcClient.upc.lookup.query({ upc: upcValue });
      if (result) {
        if (result.name) {
          form.setValue(
            "name" as Path<TFieldValues>,
            result.name as TFieldValues[Path<TFieldValues>],
          );
        }
        if (result.manufacturer) {
          form.setValue(
            "manufacturer" as Path<TFieldValues>,
            result.manufacturer as TFieldValues[Path<TFieldValues>],
          );
        } else if (result.brand) {
          form.setValue(
            "manufacturer" as Path<TFieldValues>,
            result.brand as TFieldValues[Path<TFieldValues>],
          );
        }
        if (result.priceDollars) {
          form.setValue(
            "price" as Path<TFieldValues>,
            result.priceDollars as TFieldValues[Path<TFieldValues>],
          );
        }
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

  // Pick a USDA food by name → store its fdc_id (the universal link, works for
  // any food type). The linked food then supplies nutrition + portion
  // conversions at read time, so we don't store those mappings. We deliberately
  // don't touch `upc` — that's the product's own barcode, not the food's.
  const handleUsdaSelect = (food: FoodSummaryWithLinkedProducts) => {
    form.setValue(
      "fdc_id" as Path<TFieldValues>,
      food.fdc_id as TFieldValues[Path<TFieldValues>],
    );
    const currentName = form.getValues("name" as Path<TFieldValues>) as string;
    if (!currentName) {
      form.setValue(
        "name" as Path<TFieldValues>,
        food.foodInfo.description as TFieldValues[Path<TFieldValues>],
      );
    }
  };

  const upcBlock = (
    <div className="space-y-2">
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <UnifiedTextField
            form={form}
            name={"upc" as Path<TFieldValues>}
            label="UPC (Optional)"
            placeholder="12-digit UPC code"
            nullable={true}
          />
        </div>
        <Button
          type="button"
          variant="outline"
          onClick={handleUpcLookup}
          disabled={isLookingUp || !form.watch("upc" as Path<TFieldValues>)}
        >
          {isLookingUp ? <Spinner /> : <Search className="h-4 w-4" />}
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
  );

  const content = (
    <>
      <FormSection title="Product details" compact={compact} plate>
        {!hideNameField && (
          <SideBySideFields>
            <UnifiedTextField
              form={form}
              name={"model" as Path<TFieldValues>}
              label="Model Number"
              placeholder="Enter model number"
              nullable={true}
            />
            <UnifiedTextField
              form={form}
              name={"name" as Path<TFieldValues>}
              label="Product Name"
              placeholder="Enter product name"
              nullable={false}
            />
          </SideBySideFields>
        )}

        <UnifiedTextField
          form={form}
          name={"notes" as Path<TFieldValues>}
          label="Notes"
          placeholder="Notes, URLs, etc."
          nullable={true}
        />

        {!isMisc && (
          <SideBySideFields>
            <UnifiedTextField
              form={form}
              name={"manufacturer" as Path<TFieldValues>}
              label="Manufacturer"
              placeholder="Enter manufacturer"
              nullable={false}
            />
            <CategoryFieldWithAI
              form={form}
              name={"category" as Path<TFieldValues>}
              productName={nameValue}
              manufacturer={manufacturerValue}
              disabled={isFoodForced}
              description={
                isFoodForced
                  ? "Forced to 'food' (has USDA link or ingredient)"
                  : undefined
              }
            />
          </SideBySideFields>
        )}
      </FormSection>

      {!isMisc && (
        <>
          <FormSection title="Quantity & price" compact={compact}>
            {hidePrice ? (
              <SideBySideFields>
                <NullableNumericField
                  form={form}
                  step="1"
                  name={"expectedQuantity" as Path<TFieldValues>}
                  label={
                    compact
                      ? "Expected Qty"
                      : "Expected Quantity (1 for unique items)"
                  }
                  placeholder={
                    compact ? "Unlimited" : "Leave empty for unlimited"
                  }
                />
                <NullableNumericField
                  form={form}
                  step="1"
                  name={"fdc_id" as Path<TFieldValues>}
                  label={compact ? "FDC ID" : "USDA FDC ID (Optional)"}
                  placeholder={compact ? "FDC id" : "set via USDA search above"}
                />
              </SideBySideFields>
            ) : (
              <SideBySideFields>
                <NullableNumericField
                  form={form}
                  step="1"
                  name={"expectedQuantity" as Path<TFieldValues>}
                  label="Expected Quantity (1 for unique items)"
                  placeholder="Leave empty for unlimited"
                />
                <NullableNumericField
                  form={form}
                  step="0.01"
                  name={"price" as Path<TFieldValues>}
                  label="Price per Item"
                  placeholder="e.g. 12.99"
                  prefix="$"
                />
              </SideBySideFields>
            )}
          </FormSection>

          <FormSection title="USDA & nutrition" compact={compact}>
            {!compact && (
              <UsdaFoodSearchField
                initialQuery={nameValue}
                onSelect={handleUsdaSelect}
              />
            )}

            {/* Full form pairs FDC ID beside UPC; compact renders FDC up in
                "Quantity & price" (hidePrice), so only the UPC block shows here. */}
            {hidePrice ? (
              upcBlock
            ) : (
              <SideBySideFields>
                <NullableNumericField
                  form={form}
                  step="1"
                  name={"fdc_id" as Path<TFieldValues>}
                  label="USDA FDC ID (Optional)"
                  placeholder="set via USDA search above"
                />
                {upcBlock}
              </SideBySideFields>
            )}

            {/* Which control is the active USDA link. An explicit FDC id wins
                over UPC auto-resolution (foodLookupParamFromProduct), so surface
                that precedence instead of leaving it implicit. */}
            {(upcValue || fdcValue) && (
              <p className="text-muted-foreground text-xs">
                USDA link:{" "}
                {fdcValue ? "via FDC id (explicit)" : "via UPC (auto)"}
              </p>
            )}
          </FormSection>

          <FormSection title="Ingredient" compact={compact}>
            <ComboboxFieldWithSearch
              form={form}
              name={"ingredient" as Path<TFieldValues>}
              label="Linked ingredient"
              searchType="ingredient"
            />
          </FormSection>
        </>
      )}

      {/* PendingImageUpload carries its own "Upload images" label, so no
          FormSection header — avoids an IMAGES/UPLOAD IMAGES double. */}
      <div className="space-y-2">
        <PendingImageUpload
          entityType="PRODUCT"
          onImagesChange={imageHandlers.handlePendingImagesChange}
          existingImages={existingImages}
          onExistingImagesRemove={imageHandlers.handleRemovedImagesChange}
        />

        {pendingImages.length > 0 && (
          <IdentifyProductButton form={form} pendingImages={pendingImages} />
        )}
      </div>

      {!isMisc && (
        <ArrayFieldManager<UnitMappingInput, TFieldValues>
          form={form}
          name={"unitMappings" as Path<TFieldValues>}
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
              path={`unitMappings.${index}`}
              showSource
            />
          )}
        </ArrayFieldManager>
      )}

      <ArrayFieldManager<ExternalIdInput, TFieldValues>
        form={form}
        name={"externalIds" as Path<TFieldValues>}
        title="External IDs"
        addButtonText="Add External ID"
        emptyValue={{
          source: "",
          externalId: "",
          url: undefined,
        }}
      >
        {(_, index) => (
          <>
            <div className="min-w-[8rem] flex-1">
              <UnifiedTextField
                form={form}
                name={`externalIds.${index}.source` as Path<TFieldValues>}
                label="Source"
                placeholder="e.g. amazon, mcmaster"
              />
            </div>
            <div className="min-w-[8rem] flex-1">
              <UnifiedTextField
                form={form}
                name={`externalIds.${index}.externalId` as Path<TFieldValues>}
                label="Identifier"
                placeholder="e.g. B08N5WRWNW"
              />
            </div>
            <div className="min-w-[10rem] flex-1">
              <UnifiedTextField
                form={form}
                name={`externalIds.${index}.url` as Path<TFieldValues>}
                label="URL"
                placeholder="https://..."
                nullable={true}
              />
            </div>
          </>
        )}
      </ArrayFieldManager>
    </>
  );

  if (compact) {
    return (
      <div className="space-y-4 rounded-lg border border-border/50 bg-muted/30 p-3">
        {content}
      </div>
    );
  }

  // Extra spacing between the labeled sections so the form reads as groups.
  return <div className="space-y-4">{content}</div>;
}
