import { gardenLocationKind } from "@cubby/schemas/garden";
import { locationShortcode } from "@cubby/schemas/identifiers";
import {
  locationCreateInput,
  locationUpdateData,
} from "@cubby/schemas/location";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";

import type { ComboboxItem } from "~/app/_components/combobox/combobox-types";
import { Stack } from "~/components/layout";
import { NativeSelect } from "~/components/ui/native-select";
import { entityMutation } from "~/entities/entity-mutation.functions";
import { ripple } from "~/integrations/tanstack-query/cache-tags";
import { getErrorMessage } from "~/lib/error-utils";

import { GardenField, GardenFormActions, GardenNotes } from "./garden-fields";
import { GardenPicker } from "./garden-picker";

export interface GardenLocation {
  id: string;
  name: string;
  gardenKind: "bed" | "tray" | "other" | null;
  gardenConditions: string | null;
}

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
            label="Use an existing location (optional)"
            value={existing}
            onChange={setExisting}
          />
        )}
        {!existing && (
          <GardenField label="Name" value={name} onChange={setName} required />
        )}
        <Stack gap="sm">
          <label htmlFor="garden-location-kind">Growing area</label>
          <NativeSelect
            id="garden-location-kind"
            value={kind}
            onChange={(event) =>
              setKind(gardenLocationKind.parse(event.target.value))
            }
          >
            <option value="bed">Raised bed</option>
            <option value="tray">Seed tray</option>
            <option value="other">Other growing area</option>
          </NativeSelect>
        </Stack>
        {!location && !existing && (
          <GardenPicker
            entity="location"
            label="Parent location (optional)"
            value={parent}
            onChange={setParent}
          />
        )}
        <GardenNotes
          label="Growing conditions and preferences"
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
