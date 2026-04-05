import type { ExternalIdInput } from "@cubby/schemas/external-id";
import { hasFoodIndicators } from "@cubby/schemas/product";
import type { UnitMappingInput } from "@cubby/schemas/unitmapping";
import { isMiscProduct } from "@cubby/shared";
import { Search } from "lucide-react";
import { useState } from "react";
import type { FieldValues, Path, UseFormReturn } from "react-hook-form";
import { ArrayFieldManager } from "~/components/forms/array-field-manager";
import { Button } from "~/components/ui/button";
import { Image } from "~/components/ui/image";
import { Spinner } from "~/components/ui/spinner";
import type { useImageState } from "~/hooks/useImageState";
import { useTRPCClient } from "~/trpc/react";
import {
  ComboboxFieldWithSearch,
  NullableNumericField,
  SideBySideFields,
  UnifiedTextField,
} from "../form-utils";
import { AmountFieldGroup } from "../inventory/amount-field-group";
import { type PendingImage, PendingImageUpload } from "../PendingImageUpload";
import { CategoryFieldWithAI } from "./category-field-with-ai";
import { IdentifyProductButton } from "./identify-product-with-ai";

const EMPTY_PENDING_IMAGES: PendingImage[] = [];

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
 * UPC, price, NDB, ingredient, images, unit mappings).
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
  const ndbValue = form.watch("ndb_number" as Path<TFieldValues>) as
    | number
    | null;
  const ingredientValue = form.watch("ingredient" as Path<TFieldValues>) as {
    id?: string;
  } | null;

  const isMisc = isMiscProduct(nameValue);
  const isFoodForced = hasFoodIndicators({
    ndb_number: ndbValue,
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

  const content = (
    <>
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
        <>
          {compact ? (
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
                    ? "Forced to 'food' (has NDB number or ingredient)"
                    : undefined
                }
              />
            </SideBySideFields>
          ) : (
            <>
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
                    ? "Forced to 'food' (has NDB number or ingredient)"
                    : undefined
                }
              />
            </>
          )}

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
                name={"ndb_number" as Path<TFieldValues>}
                label={compact ? "NDB Number" : "NDB Number (Optional)"}
                placeholder={compact ? "1000-99999" : "NDB number (1000-99999)"}
              />
            </SideBySideFields>
          ) : (
            <>
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
              <NullableNumericField
                form={form}
                step="1"
                name={"ndb_number" as Path<TFieldValues>}
                label="NDB Number (Optional)"
                placeholder="NDB number (1000-99999)"
              />
            </>
          )}

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
                size="sm"
                onClick={handleUpcLookup}
                disabled={
                  isLookingUp || !form.watch("upc" as Path<TFieldValues>)
                }
                className="mb-[2px]"
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

          <ComboboxFieldWithSearch
            form={form}
            name={"ingredient" as Path<TFieldValues>}
            label="Ingredient"
            searchType="ingredient"
          />
        </>
      )}

      <PendingImageUpload
        entityType="PRODUCT"
        onImagesChange={imageHandlers.handlePendingImagesChange}
        existingImages={existingImages}
        onExistingImagesRemove={imageHandlers.handleRemovedImagesChange}
        className="mt-4"
      />

      {pendingImages.length > 0 && (
        <IdentifyProductButton form={form} pendingImages={pendingImages} />
      )}

      {!isMisc && (
        <ArrayFieldManager<UnitMappingInput, TFieldValues>
          form={form}
          name={"unitMappings" as Path<TFieldValues>}
          title="Unit Mappings"
          addButtonText="Add Mapping"
          titleClassName={compact ? "text-sm" : undefined}
          className={compact ? "space-y-2" : undefined}
          emptyValue={{
            a: { value: 1, unit: "" },
            b: { value: 1, unit: "" },
            source: null,
          }}
        >
          {(_, index) => (
            <>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <h5 className="font-medium text-sm">From</h5>
                  <AmountFieldGroup
                    form={form}
                    valuePath={
                      `unitMappings.${index}.a.value` as Path<TFieldValues>
                    }
                    unitPath={
                      `unitMappings.${index}.a.unit` as Path<TFieldValues>
                    }
                  />
                </div>

                <div className="space-y-2">
                  <h5 className="font-medium text-sm">To</h5>
                  <AmountFieldGroup
                    form={form}
                    valuePath={
                      `unitMappings.${index}.b.value` as Path<TFieldValues>
                    }
                    unitPath={
                      `unitMappings.${index}.b.unit` as Path<TFieldValues>
                    }
                  />
                </div>
              </div>

              <UnifiedTextField
                form={form}
                name={`unitMappings.${index}.source` as Path<TFieldValues>}
                label="Source (Optional)"
                placeholder="Enter source"
                nullable={true}
              />
            </>
          )}
        </ArrayFieldManager>
      )}

      <ArrayFieldManager<ExternalIdInput, TFieldValues>
        form={form}
        name={"externalIds" as Path<TFieldValues>}
        title="External IDs"
        addButtonText="Add External ID"
        titleClassName={compact ? "text-sm" : undefined}
        className={compact ? "space-y-2" : undefined}
        emptyValue={{
          source: "",
          externalId: "",
          url: undefined,
        }}
      >
        {(_, index) => (
          <>
            <SideBySideFields>
              <UnifiedTextField
                form={form}
                name={`externalIds.${index}.source` as Path<TFieldValues>}
                label="Source"
                placeholder="e.g. amazon, mcmaster, mouser"
              />
              <UnifiedTextField
                form={form}
                name={`externalIds.${index}.externalId` as Path<TFieldValues>}
                label="Identifier"
                placeholder="e.g. B08N5WRWNW"
              />
            </SideBySideFields>
            <UnifiedTextField
              form={form}
              name={`externalIds.${index}.url` as Path<TFieldValues>}
              label="URL (Optional)"
              placeholder="https://..."
              nullable={true}
            />
          </>
        )}
      </ArrayFieldManager>
    </>
  );

  if (compact) {
    return (
      <div className="space-y-3 rounded-lg border border-border/50 bg-muted/30 p-3">
        {content}
      </div>
    );
  }

  return content;
}
