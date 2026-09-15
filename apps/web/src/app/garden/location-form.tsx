import {
  gardenLocationKind,
  gardenLocationSummaryOut,
} from "@cubby/schemas/garden";
import { locationShortcode } from "@cubby/schemas/identifiers";
import {
  locationCreateInput,
  locationUpdateData,
} from "@cubby/schemas/location";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import type { z } from "zod";

import type { ComboboxItem } from "~/app/_components/combobox/combobox-types";
import { Stack } from "~/components/layout";
import { Label } from "~/components/ui/label";
import { NativeSelect } from "~/components/ui/native-select";
import { entityMutation } from "~/entities/entity-mutation.functions";
import { ripple } from "~/integrations/tanstack-query/cache-tags";
import { getErrorMessage } from "~/lib/error-utils";

import {
  GARDEN_DIALOG_FORM_ID,
  GardenField,
  GardenFormActions,
  GardenNotes,
} from "./garden-fields";
import { GardenPicker } from "./garden-picker";
import { gardenStrings } from "./garden-strings";

export type GardenLocation = Pick<
  z.infer<typeof gardenLocationSummaryOut>,
  "id" | "name" | "gardenKind" | "gardenConditions"
>;

export function GardenLocationForm({
  location,
  onSaved,
  onCancel,
}: {
  location?: GardenLocation;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [existing, setExisting] = useState<ComboboxItem | null>(null);
  const [name, setName] = useState(location?.name ?? "");
  const [kind, setKind] = useState(location?.gardenKind ?? "bed");
  const [conditions, setConditions] = useState(
    location?.gardenConditions ?? "",
  );
  const [parent, setParent] = useState<ComboboxItem | null>(null);
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    meta: { invalidates: ripple.garden },
    mutationFn: async () => {
      const target = location?.id ?? existing?.id;
      const data = {
        gardenKind: kind,
        gardenConditions: conditions.trim() || null,
      };
      if (target)
        await entityMutation.mutate.call({
          entity: "location",
          action: "update",
          id: locationShortcode.parse(target),
          data: locationUpdateData.parse({
            ...data,
            name: location ? name : undefined,
          }),
        });
      else
        await entityMutation.mutate.call({
          entity: "location",
          action: "create",
          data: locationCreateInput.parse({
            ...data,
            name,
            parentId: parent?.id ?? null,
          }),
        });
    },
    onSuccess: onSaved,
    onError: (error) => setError(getErrorMessage(error)),
  });
  return (
    <form
      id={GARDEN_DIALOG_FORM_ID}
      onSubmit={(event) => {
        event.preventDefault();
        setError(null);
        save.mutate();
      }}
    >
      <Stack gap="lg">
        {!location && (
          <GardenPicker
            entity="location"
            label={gardenStrings.location.existingPickerCaption}
            placeholder={gardenStrings.location.existingPickerPlaceholder}
            value={existing}
            onChange={setExisting}
          />
        )}
        {!existing && (
          <GardenField
            label={gardenStrings.location.nameField}
            value={name}
            onChange={setName}
            required
          />
        )}
        <Stack gap="sm">
          <Label htmlFor="garden-location-kind">
            {gardenStrings.location.kindField}
          </Label>
          <NativeSelect
            id="garden-location-kind"
            value={kind}
            onChange={(event) =>
              setKind(gardenLocationKind.parse(event.target.value))
            }
          >
            <option value="bed">{gardenStrings.location.kindLabel.bed}</option>
            <option value="tray">
              {gardenStrings.location.kindLabel.tray}
            </option>
            <option value="other">
              {gardenStrings.location.kindLabel.other}
            </option>
          </NativeSelect>
        </Stack>
        {!location && !existing && (
          <GardenPicker
            entity="location"
            label={gardenStrings.location.parentField}
            value={parent}
            onChange={setParent}
          />
        )}
        <GardenNotes
          label={gardenStrings.location.conditionsField}
          value={conditions}
          onChange={setConditions}
        />
        <GardenFormActions
          pending={save.isPending}
          error={error}
          onCancel={onCancel}
        />
      </Stack>
    </form>
  );
}
