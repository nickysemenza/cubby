"use client";
import { type FC } from "react";
import { useForm } from "react-hook-form";
import { useImageState } from "~/hooks/useImageState";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { ComboboxItem } from "~/app/_components/combobox/combobox-types";
import { buildLocationComboboxItem } from "~/app/_components/combobox/combobox-builders";
import {
  locationType,
  type LocationOut,
  type LocationCreateInput,
  type LocationUpdateInput,
} from "~/schemas/location";
import {
  type CreateModeProps,
  type EditModeProps,
  FormWrapper,
  UnifiedTextField,
  getSubmitButtonText,
  ComboboxField,
  detectComboboxIdChange,
  SideBySideFields,
  SelectField,
} from "../form-utils";
import { PendingImageUpload } from "../PendingImageUpload";
import { type ImageOut } from "~/schemas/image";

import { WithLocationSearch } from "../combobox/with-search-hook";

// Form schema for location form
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
      parent:
        location && location.parent
          ? buildLocationComboboxItem(location.parent)
          : null,
    },
  });

  const handleSubmit = async (values: LocationFormValues) => {
    if (mode === "create") {
      try {
        // For creation, pass all fields including pending image IDs
        const createData: LocationCreateInput = {
          name: values.name,
          type: values.type,
          parentId: values.parent ? values.parent.id : null,
          ...getImageData(true), // Apply pending images for creation
        };

        // Create the location with images in a single transaction
        await props.onCreate(createData);

        // Success message is shown by the parent component
      } catch (error) {
        console.error("Failed to create location:", error);
        // The parent component will handle displaying the error
      }
    } else if (mode === "edit" && location) {
      try {
        // Build update object
        const updates: LocationUpdateInput["data"] = {};

        // Check if name has changed
        if (values.name !== location.name) {
          updates.name = values.name;
        }

        // Check if type has changed
        if (values.type !== location.type) {
          updates.type = values.type;
        }

        // Check if parent has changed
        const parentIdChange = detectComboboxIdChange(
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

          // Update the location with images in a single transaction
          await props.onEdit(updateData);

          // Success message is shown by the parent component
        } else if (onCancel) {
          // If no changes, just run the cancel function
          onCancel();
        }
      } catch (error) {
        console.error("Failed to update location:", error);
        // The parent component will handle displaying the error
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
          options={Object.values(locationType.enum).map((type) => ({
            value: type,
            label: type,
          }))}
          placeholder="Select a location type"
        />
      </SideBySideFields>

      <WithLocationSearch>
        {({ findItems, onCreateNew }) => (
          <ComboboxField
            form={form}
            name="parent"
            label="Parent Location (Optional)"
            findItems={findItems}
            onCreateNew={onCreateNew}
            insideDialog={mode === "create"}
          />
        )}
      </WithLocationSearch>

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
