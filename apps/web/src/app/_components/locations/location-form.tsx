"use client";
import type { FC } from "react";
import { useForm } from "react-hook-form";
import { useImageState } from "~/hooks/useImageState";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { buildLocationComboboxItem } from "~/app/_components/combobox/combobox-builders";
import {
  locationType,
  locationTypeOptions,
  type LocationOut,
  type LocationCreateInput,
  type LocationUpdateInput,
} from "~/schemas/location";
import type { LocationId } from "~/schemas/identifiers";
import {
  type CreateModeProps,
  type EditModeProps,
  FormWrapper,
  UnifiedTextField,
  getSubmitButtonText,
  ComboboxFieldWithSearch,
  detectComboboxIdChange,
  buildUpdateObject,
  SideBySideFields,
  SelectField,
} from "../form-utils";
import { PendingImageUpload } from "../PendingImageUpload";
import type { ImageOut } from "~/schemas/image";
import { ComboboxItem } from "../combobox/combobox-types";
import { getOptionalLocationId } from "~/schemas/form-fields";

// Form schema for location form (simple Zod schema without z.custom)
const formSchema = z.object({
  name: z.string().min(1, "Name is required"),
  type: locationType,
  parent: ComboboxItem.nullable(),
});

type LocationFormValues = z.infer<typeof formSchema>;

// Props for create mode
interface CreateLocationFormProps extends CreateModeProps<LocationCreateInput> {
  location?: never;
  initialName?: string;
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
    getImageData,
    hasImageChanges,
  } = useImageState();

  // Get the location entity in edit mode
  const location = mode === "edit" ? props.entity : undefined;
  const initialName = mode === "create" ? props.initialName : undefined;

  // Initialize form with default values or existing location data
  const form = useForm<LocationFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: location ? location.name : (initialName ?? ""),
      type: location ? location.type : "room",
      parent: location?.parent
        ? buildLocationComboboxItem(location.parent)
        : null,
    },
  });

  const handleSubmit = async (values: LocationFormValues) => {
    if (mode === "create") {
      // For creation, pass all fields including pending image IDs
      const createData: LocationCreateInput = {
        name: values.name,
        type: values.type,
        parentId: getOptionalLocationId(values.parent) ?? null,
        ...getImageData(true), // Apply pending images for creation
      };

      await props.onCreate(createData);
    } else if (mode === "edit" && location) {
      // Build update object for simple fields
      const updates: LocationUpdateInput["data"] = buildUpdateObject(
        location,
        values,
        ["name", "type"],
      );

      // Check if parent has changed (combobox requires special handling)
      const parentIdChange = detectComboboxIdChange<LocationId>(
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

  const buttonText = getSubmitButtonText(mode, isPending);

  return (
    <FormWrapper
      form={form}
      onSubmit={handleSubmit}
      error={error}
      isPending={isPending}
      onCancel={onCancel}
      submitButtonText={buttonText}
    >
      <SideBySideFields>
        <UnifiedTextField
          form={form}
          name="name"
          label="Name"
          placeholder="Enter location name"
          nullable={false}
        />

        <SelectField
          form={form}
          name="type"
          label="Type"
          options={locationTypeOptions}
          placeholder="Select a location type"
        />
      </SideBySideFields>

      <ComboboxFieldWithSearch
        form={form}
        name="parent"
        label="Parent Location (Optional)"
        searchType="location"
      />

      {/* Show image upload in both create and edit modes */}
      <PendingImageUpload
        entityType="LOCATION"
        onImagesChange={handlePendingImagesChange}
        existingImages={
          mode === "edit" && location?.images ? location.images : []
        }
        onExistingImagesRemove={handleRemovedImagesChange}
        className="mt-4"
      />
    </FormWrapper>
  );
};
