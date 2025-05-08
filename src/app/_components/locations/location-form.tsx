"use client";
import { type FC } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { ComboboxItem } from "~/app/_components/combobox/combobox-types";
import { buildLocationComboboxItem } from "~/app/_components/combobox/utils";
import {
  locationBase,
  locationType,
  type LocationOut,
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

import { WithLocationSearch } from "../combobox/with-search-hook";

// Form schema for location form
const formSchema = z.object({
  name: z.string().min(1, "Name is required"),
  type: locationType,
  parent: ComboboxItem.nullable(),
});

export type LocationFormValues = z.infer<typeof formSchema>;

// Use the backend type for creation data
export type CreateLocationData = z.infer<typeof locationBase> & {
  parentId: string | null;
};

// Define the props passed by parent for update operation
export type UpdateLocationData = {
  id: string;
  data: Partial<CreateLocationData>;
};

// Props for create mode
interface CreateLocationFormProps extends CreateModeProps<CreateLocationData> {
  location?: never;
  initialName?: string;
}

// Props for edit mode
interface EditLocationFormProps
  extends EditModeProps<UpdateLocationData, LocationOut> {
  entity: LocationOut & { parent?: LocationOut | null };
}

type LocationFormProps = CreateLocationFormProps | EditLocationFormProps;

export const LocationForm: FC<LocationFormProps> = (props) => {
  const { mode, isPending, error, onCancel } = props;

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

  const handleSubmit = (values: LocationFormValues) => {
    if (mode === "create") {
      // For creation, pass all fields
      const createData: CreateLocationData = {
        name: values.name,
        type: values.type,
        parentId: values.parent ? values.parent.id : null,
      };
      props.onCreate(createData);
    } else if (mode === "edit" && location) {
      // Build update object
      const updates: Partial<CreateLocationData> = {};

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

      // Only update if there are changes
      if (Object.keys(updates).length > 0) {
        const updateData: UpdateLocationData = {
          id: location.id,
          data: updates,
        };
        props.onEdit(updateData);
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
    </FormWrapper>
  );
};
