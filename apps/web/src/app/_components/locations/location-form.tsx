import type { ImageOut } from "@cubby/schemas/image";
import type {
  LocationCreateInput,
  LocationOut,
  LocationUpdateInput,
  locationType,
} from "@cubby/schemas/location";
import {
  collectionSlugsFromTags,
  collectionTagFromSlug,
  normalizeCollectionSlug,
} from "@cubby/shared/collection-tag";
import type { FC } from "react";
import { z } from "zod";

import { buildLocationComboboxItem } from "~/app/_components/combobox/combobox-builders";
import type { ComboboxItem } from "~/app/_components/combobox/combobox-types";
import {
  getOptionalLocationId,
  getOptionalProductShortcode,
} from "~/app/_components/form-fields";
import { AliasesField, filterAliases } from "~/components/forms/aliases-field";
import { Card, CardContent } from "~/components/ui/card";
import { EntityPrimitiveFields } from "~/entities/editing/entity-primitive-fields";
import { useEntityFormController } from "~/entities/editing/use-entity-form-controller";
import { useImageState } from "~/hooks/useImageState";

import {
  type EntityFormProps,
  FormWrapper,
  SideBySideFields,
} from "../form-utils";
import { ComboboxFieldWithSearch } from "../form-utils/combobox-field-with-search";
import { PendingImageUpload } from "../PendingImageUpload";
import { TypeFieldWithAI } from "./type-field-with-ai";

// Module-level so `useEntityFormController`'s resolver memoization sees a
// stable reference across renders (never a fresh inline array/object).
const LOCATION_FORM_FIELDS = [
  "name",
  "aliases",
  "tags",
  "type",
  "productId",
  "parentId",
] as const;
// `collections` is editor-only (folded into `tags` at submit, see
// `foldCollectionsIntoTags`) — the generated field-schema map has no entry
// for it, so it's declared here instead of picked from that map.
const LOCATION_FORM_EXTEND = { collections: z.array(z.string()) };

/**
 * `type` and `product` are alternatives, not companions: form factor is a fact
 * about the SKU, so a location linked to a Product stores no type of its own.
 * `type`'s coercion (null when linked, a concrete default when just unlinked)
 * lives in `transform.diffValues`/`transform.create` below, not in the
 * resolver — a `.refine()` here would make the resolver schema a `ZodEffects`,
 * which react-hook-form's `UseFormReturn` generics reject.
 */
interface LocationFormValues {
  name: string;
  aliases: string[];
  // Editor-only: folded into `tags` at submit (see `foldCollectionsIntoTags`).
  collections: string[];
  type: z.infer<typeof locationType> | null;
  product: ComboboxItem | null;
  parent: ComboboxItem | null;
}

function foldCollectionsIntoTags(collections: string[]): string[] {
  return filterAliases(collections)
    .map(normalizeCollectionSlug)
    .filter(Boolean)
    .map(collectionTagFromSlug);
}

// Props for create mode
interface CreateLocationFormProps {
  location?: never;
  initialName?: string;
  initialParent?: LocationOut;
}

type LocationFormProps = EntityFormProps<
  LocationCreateInput,
  LocationUpdateInput,
  LocationOut & {
    parent?: LocationOut | null;
    images?: ImageOut[]; // Images from DB
  }
> &
  CreateLocationFormProps;

export const LocationForm: FC<LocationFormProps> = (props) => {
  const { mode, onCancel } = props;
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

  // Explicit annotation (rather than letting `useEntityFormController` infer
  // `TFieldValues` from this object) — a branded id in `location.product.id`
  // would otherwise infer a narrower shape than `LocationFormValues`, and
  // that mismatch surfaces confusingly far away, in every `form.control`
  // consumer below.
  const defaultValues: LocationFormValues = {
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
  };

  const controller = useEntityFormController("location", props, {
    fields: LOCATION_FORM_FIELDS,
    extend: LOCATION_FORM_EXTEND,
    editableScalarKeys: ["name", "aliases", "tags", "type"],
    defaultValues,
    hasAdditionalChanges: hasImageChanges,
    transform: {
      // `productId` in `referenceUpdates` means the link just changed this
      // submit — a fresh link always clears `type`; a fresh unlink needs a
      // concrete default since `values.type` was never a live control while
      // linked. Unchanged, `type` just follows the CURRENT link state.
      diffValues: (values, referenceUpdates) => {
        const productIdChanged = "productId" in referenceUpdates;
        const linked = productIdChanged
          ? referenceUpdates.productId != null
          : (location?.product?.id ?? null) != null;
        return {
          ...values,
          aliases: filterAliases(values.aliases),
          tags: foldCollectionsIntoTags(values.collections),
          type: linked
            ? null
            : productIdChanged
              ? (values.type ?? "box")
              : values.type,
        };
      },
      create: (values) => {
        const productId = getOptionalProductShortcode(values.product) ?? null;
        return {
          name: values.name,
          aliases: filterAliases(values.aliases),
          tags: foldCollectionsIntoTags(values.collections),
          type: productId ? null : values.type,
          productId,
          parentId: getOptionalLocationId(values.parent) ?? null,
          ...getImageData(true), // Apply pending images for creation
        };
      },
      edit: (updates) => ({
        id: location!.id,
        data: { ...updates, ...getImageData() },
      }),
    },
  });
  const { form, handleSubmit, isPending, error, submitButtonText } = controller;

  // Watch name field to pass to TypeFieldWithAI for AI suggestions
  const nameValue = form.watch("name");
  // A linked location takes its form factor from the SKU, so the type control
  // is hidden rather than left to disagree with the product.
  const linkedProduct = form.watch("product");

  return (
    <FormWrapper
      form={form}
      onSubmit={handleSubmit}
      error={error}
      isPending={isPending}
      onCancel={onCancel}
      submitButtonText={submitButtonText}
    >
      <Card className="overflow-visible">
        <CardContent className="space-y-2 px-4 py-1">
          <SideBySideFields>
            <EntityPrimitiveFields
              entity="location"
              mode={mode}
              section="main"
              options={{ name: { placeholder: "Enter location name" } }}
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
