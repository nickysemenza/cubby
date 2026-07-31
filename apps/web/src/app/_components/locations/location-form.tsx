import type { LocationShortcode } from "@cubby/schemas/identifiers";
import type { ImageOut } from "@cubby/schemas/image";
import {
  type LocationCreateInput,
  type LocationOut,
  type LocationUpdateInput,
  locationType,
} from "@cubby/schemas/location";
import { zodResolver } from "@hookform/resolvers/zod";
import type { FC } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { buildLocationComboboxItem } from "~/app/_components/combobox/combobox-builders";
import {
  getOptionalLocationId,
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
const formSchema = z.object({
  name: z.string().min(1, "Name is required"),
  aliases: z.array(z.string()),
  type: locationType,
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
      type: location ? location.type : "room",
      parent: location?.parent
        ? buildLocationComboboxItem(location.parent)
        : initialParent
          ? buildLocationComboboxItem(initialParent)
          : null,
    },
  });

  // Watch name field to pass to TypeFieldWithAI for AI suggestions
  const nameValue = form.watch("name");

  const handleSubmit = async (values: LocationFormValues) => {
    const aliases = filterAliases(values.aliases);

    if (mode === "create") {
      // For creation, pass all fields including pending image IDs
      const createData: LocationCreateInput = {
        name: values.name,
        aliases,
        type: values.type,
        parentId: getOptionalLocationId(values.parent) ?? null,
        ...getImageData(true), // Apply pending images for creation
      };

      await props.onCreate(createData);
    } else if (mode === "edit" && location) {
      // Build update object for simple fields
      const updates: LocationUpdateInput["data"] = buildUpdateObject(
        location,
        { ...values, aliases },
        ["name", "aliases", "type"],
      );

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

            <TypeFieldWithAI form={form} name="type" locationName={nameValue} />
          </SideBySideFields>

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
