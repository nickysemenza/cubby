import type {
  LocationShortcode,
  ProductShortcode,
} from "@cubby/schemas/identifiers";
import type { ImageOut } from "@cubby/schemas/image";
import {
  type LocationCreateInput,
  type LocationOut,
  type LocationUpdateInput,
  locationType,
} from "@cubby/schemas/location";
import {
  collectionSlugsFromTags,
  collectionTagFromSlug,
  normalizeCollectionSlug,
} from "@cubby/shared/collection-tag";
import { zodResolver } from "@hookform/resolvers/zod";
import type { FC } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { buildLocationComboboxItem } from "~/app/_components/combobox/combobox-builders";
import { ComboboxItem } from "~/app/_components/combobox/combobox-types";
import {
  getOptionalLocationId,
  getOptionalProductShortcode,
  optionalLocationField,
} from "~/app/_components/form-fields";
import { AliasesField, filterAliases } from "~/components/forms/aliases-field";
import { Card, CardContent } from "~/components/ui/card";
import { useImageState } from "~/hooks/useImageState";
import {
  buildUpdateObject,
  type CreateModeProps,
  detectComboboxIdChange,
  type EditModeProps,
  FormWrapper,
  getSubmitButtonText,
  SideBySideFields,
  UnifiedTextField,
} from "../form-utils";
import { ComboboxFieldWithSearch } from "../form-utils/combobox-field-with-search";
import { PendingImageUpload } from "../PendingImageUpload";
import { TypeFieldWithAI } from "./type-field-with-ai";

// Form schema for location form (simple Zod schema without z.custom)
/**
 * `type` and `product` are alternatives, not companions: form factor is a fact
 * about the SKU, so a location linked to a Product stores no type of its own.
 *
 * "at least one is set" is enforced structurally rather than by a `.refine()`
 * — the type control always holds a value when no product is linked, and
 * submit nulls it only when one is. A refine here would make this a
 * `ZodEffects`, which react-hook-form's `UseFormReturn` generics reject.
 */
const formSchema = z.object({
  name: z.string().min(1, "Name is required"),
  aliases: z.array(z.string()),
  collections: z.array(z.string()),
  type: locationType.nullable(),
  product: ComboboxItem.nullable(),
  parent: optionalLocationField,
});

type LocationFormValues = z.infer<typeof formSchema>;

// Props for create mode
interface CreateLocationFormProps extends CreateModeProps<LocationCreateInput> {
  location?: never;
  initialName?: string;
  initialParent?: LocationOut;
  onCreate: (data: LocationCreateInput) => Promise<LocationOut>; // Modified to return Promise
}

// Props for edit mode
interface EditLocationFormProps
  extends EditModeProps<LocationUpdateInput, LocationOut> {
  entity: LocationOut & {
    parent?: LocationOut | null;
    images?: ImageOut[]; // Images from DB
  };
}

type LocationFormProps = CreateLocationFormProps | EditLocationFormProps;

export const LocationForm: FC<LocationFormProps> = (props) => {
  const { mode, isPending, error, onCancel } = props;
  const {
    handlePendingImagesChange,
    handleRemovedImagesChange,
    handleExistingImagesReorder,
    getImageData,
    hasImageChanges,
  } = useImageState();

  // Get the location entity in edit mode
  const location = mode === "edit" ? props.entity : undefined;
  const initialName = mode === "create" ? props.initialName : undefined;
  const initialParent = mode === "create" ? props.initialParent : undefined;

  // Initialize form with default values or existing location data
  const form = useForm<LocationFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: location ? location.name : (initialName ?? ""),
      aliases: location ? location.aliases : [],
      collections: collectionSlugsFromTags(location?.tags ?? []),
      type: location ? location.type : "room",
      product: location?.product
        ? { id: location.product.id, name: location.product.name }
        : null,
      parent: location?.parent
        ? buildLocationComboboxItem(location.parent)
        : initialParent
          ? buildLocationComboboxItem(initialParent)
          : null,
    },
  });

  // Watch name field to pass to TypeFieldWithAI for AI suggestions
  const nameValue = form.watch("name");
  // A linked location takes its form factor from the SKU, so the type control
  // is hidden rather than left to disagree with the product.
  const linkedProduct = form.watch("product");

  const handleSubmit = async (values: LocationFormValues) => {
    const aliases = filterAliases(values.aliases);
    const tags = filterAliases(values.collections)
      .map(normalizeCollectionSlug)
      .filter(Boolean)
      .map(collectionTagFromSlug);

    if (mode === "create") {
      // For creation, pass all fields including pending image IDs
      const productId = getOptionalProductShortcode(values.product) ?? null;
      const createData: LocationCreateInput = {
        name: values.name,
        aliases,
        tags,
        type: productId ? null : values.type,
        productId,
        parentId: getOptionalLocationId(values.parent) ?? null,
        ...getImageData(true), // Apply pending images for creation
      };

      await props.onCreate(createData);
    } else if (mode === "edit" && location) {
      // Build update object for simple fields
      const productId = getOptionalProductShortcode(values.product) ?? null;
      const updates: LocationUpdateInput["data"] = buildUpdateObject(
        location,
        { ...values, aliases, tags, type: productId ? null : values.type },
        ["name", "aliases", "tags", "type"],
      );

      // Identity swap: linking a product clears the now-redundant type, and
      // unlinking restores one so the location isn't left describing nothing.
      const productIdChange = detectComboboxIdChange<ProductShortcode>(
        location.product?.id,
        values.product,
      );
      if (productIdChange !== undefined) {
        updates.productId = productIdChange;
        updates.type = productIdChange ? null : (values.type ?? "box");
      }

      // Check if parent has changed (combobox requires special handling)
      const parentIdChange = detectComboboxIdChange<LocationShortcode>(
        location.parent?.id,
        values.parent,
      );
      if (parentIdChange !== undefined) {
        updates.parentId = parentIdChange;
      }

      // Check if we have any changes (field changes or image changes)
      const imageChanges = hasImageChanges();
      const hasFieldChanges = Object.keys(updates).length > 0;

      // Only update if there are changes
      if (hasFieldChanges || imageChanges) {
        // Create the update data object
        const updateData: LocationUpdateInput = {
          id: location.id,
          data: {
            ...updates,
            ...getImageData(), // Apply image updates
          },
        };

        await props.onEdit(updateData);
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
      <Card className="overflow-visible">
        <CardContent className="space-y-2 px-4 py-1">
          <SideBySideFields>
            <UnifiedTextField
              form={form}
              name="name"
              label="Name"
              placeholder="Enter location name"
              nullable={false}
            />

            {!linkedProduct && (
              <TypeFieldWithAI
                form={form}
                name="type"
                locationName={nameValue}
              />
            )}
          </SideBySideFields>

          {/* The SKU this location IS — a tote, bin or rack you own. Supplies
              the form factor, which is why Type disappears once it's set. */}
          <ComboboxFieldWithSearch
            form={form}
            name="product"
            label="This location is a… (Optional)"
            searchType="product"
          />

          <ComboboxFieldWithSearch
            form={form}
            name="parent"
            label="Parent Location (Optional)"
            searchType="location"
          />
        </CardContent>
      </Card>

      {/* Alternate names — searched and embedded alongside the location name
          (e.g. "Deep freezer" for the garage chest freezer). */}
      <AliasesField<LocationFormValues>
        form={form}
        placeholder="e.g. Deep freezer"
      />

      <AliasesField<LocationFormValues>
        form={form}
        name="collections"
        title="Collections"
        addButtonText="Add Collection"
        placeholder="e.g. painting"
      />

      {/* Show image upload in both create and edit modes */}
      <PendingImageUpload
        entityType="LOCATION"
        onImagesChange={handlePendingImagesChange}
        existingImages={
          mode === "edit" && location?.images ? location.images : []
        }
        onExistingImagesRemove={handleRemovedImagesChange}
        onExistingImagesReorder={handleExistingImagesReorder}
        className="mt-4"
      />
    </FormWrapper>
  );
};
