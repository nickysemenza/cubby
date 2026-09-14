import {
  gardenEntryUpdateData,
  gardenRecordEntryInput,
  type GardenEntryOut,
} from "@cubby/schemas/garden";
import { imageShortcode } from "@cubby/schemas/identifiers";
import { useMutation } from "@tanstack/react-query";
import { useRef, useState } from "react";

import type { ComboboxItem } from "~/app/_components/combobox/combobox-types";
import EntityImageList from "~/app/_components/EntityImageList";
import { Stack } from "~/components/layout";
import { NativeSelect } from "~/components/ui/native-select";
import { entityMutation } from "~/entities/entity-mutation.functions";
import { ripple } from "~/integrations/tanstack-query/cache-tags";
import { getErrorMessage } from "~/lib/error-utils";
import { householdLocalDate } from "~/lib/household-date";

import { EntryContextFields } from "./entry-context-fields";
import {
  GARDEN_DIALOG_FORM_ID,
  GardenField,
  GardenFormActions,
  GardenNotes,
} from "./garden-fields";
import {
  GardenPhotos,
  uploadGardenPhotos,
  type GardenPhotoDraft,
} from "./garden-photos";
import { garden } from "./garden.functions";

const productionOperations = {
  recordEntry: garden.recordEntry,
  mutate: entityMutation.mutate,
};
function initialEntryFields(entry?: GardenEntryOut) {
  return {
    kind: entry?.kind ?? "observation",
    observedOn: entry?.observedOn ?? householdLocalDate(),
    note: entry?.note ?? "",
    harvestAmount: entry?.harvestAmount ?? "",
  };
}
export function EntryForm({
  locationId,
  plantingId,
  entry,
  onSaved,
  onCancel,
  operations = productionOperations,
  loadOptions,
}: {
  locationId: string;
  plantingId?: string;
  entry?: GardenEntryOut;
  onSaved: () => void;
  onCancel: () => void;
  operations?: typeof productionOperations;
  loadOptions?: typeof garden.options;
}) {
  const [place, setPlace] = useState<ComboboxItem | null>({
    id: entry?.locationId ?? locationId,
    name: entry?.locationName ?? "Selected location",
  });
  const [crop, setCrop] = useState<ComboboxItem | null>(() => {
    const id = entry ? entry.plantingId : plantingId;
    return id ? { id, name: entry?.plantingName ?? "Selected planting" } : null;
  });
  const initial = initialEntryFields(entry);
  const [kind, setKind] = useState(initial.kind);
  const [observedOn, setObservedOn] = useState(initial.observedOn);
  const [note, setNote] = useState(initial.note);
  const [harvestAmount, setHarvestAmount] = useState(initial.harvestAmount);
  const [photos, setPhotos] = useState<GardenPhotoDraft[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [removedImages, setRemovedImages] = useState<string[]>([]);
  const saving = useRef(false);
  const isMove = entry?.kind === "move";
  // Saving the batch is deliberately sequential: failed uploads leave both the form and completed uploads intact.
  const save = useMutation({
    meta: { invalidates: ripple.garden },
    mutationFn: async () => {
      const data = {
        locationId: place?.id,
        plantingId: crop?.id ?? null,
        kind,
        observedOn,
        note: note.trim() || null,
        harvestAmount: kind === "harvest" ? harvestAmount.trim() || null : null,
      };
      if (!place) throw new Error("Choose the location where this happened.");
      const pendingImageIds = await uploadGardenPhotos(photos, undefined, () =>
        setPhotos([...photos]),
      );
      if (entry) {
        await operations.mutate.call({
          entity: "gardenEntry",
          action: "update",
          id: entry.id,
          data: gardenEntryUpdateData.parse({
            ...data,
            pendingImageIds,
            removeImageIds: removedImages.map((id) => imageShortcode.parse(id)),
          }),
        });
      } else {
        await operations.recordEntry.call(
          gardenRecordEntryInput.parse({ ...data, pendingImageIds }),
        );
      }
    },
    onSuccess: onSaved,
    onError: (error) => setError(getErrorMessage(error)),
    onSettled: () => {
      saving.current = false;
    },
  });
  return (
    <form
      id={GARDEN_DIALOG_FORM_ID}
      onSubmit={(event) => {
        event.preventDefault();
        if (saving.current) return;
        saving.current = true;
        setError(null);
        save.mutate();
      }}
    >
      <Stack gap="lg">
        <EntryContextFields
          location={place}
          planting={crop}
          onLocationChange={setPlace}
          onPlantingChange={setCrop}
          disabled={save.isPending || isMove}
          loadOptions={loadOptions}
        />
        <Stack gap="sm">
          <label htmlFor="garden-entry-kind">Entry type</label>
          <NativeSelect
            id="garden-entry-kind"
            value={kind}
            onChange={(event) =>
              setKind(
                event.target.value === "harvest" ? "harvest" : "observation",
              )
            }
            disabled={save.isPending || isMove}
          >
            <option value="observation">Note or photos</option>
            <option value="harvest">Harvest</option>
            {isMove && <option value="move">Move</option>}
          </NativeSelect>
        </Stack>
        <GardenField
          label="Observation date"
          type="date"
          value={observedOn}
          onChange={setObservedOn}
          required
          disabled={save.isPending || isMove}
        />
        {isMove && (
          <p className="text-sm text-muted-foreground">
            Correct move dates in the planting’s location history so its journal
            stays consistent.
          </p>
        )}
        {kind === "harvest" && (
          <GardenField
            label="Harvest amount (optional)"
            value={harvestAmount}
            onChange={setHarvestAmount}
            placeholder="A handful, 6 tomatoes, 300 g…"
            disabled={save.isPending}
          />
        )}
        <GardenNotes
          value={note}
          onChange={setNote}
          disabled={save.isPending}
        />
        {entry && entry.images.length > 0 && (
          <EntityImageList
            images={entry.images.filter(
              (image) => !removedImages.includes(image.id),
            )}
            showViewAllButton={false}
            imageFit="contain"
            onRemove={
              save.isPending
                ? undefined
                : (id) => setRemovedImages((current) => [...current, id])
            }
          />
        )}
        <GardenPhotos
          photos={photos}
          onChange={setPhotos}
          disabled={save.isPending}
        />
        <GardenFormActions
          pending={save.isPending}
          error={error}
          onCancel={onCancel}
          label={entry ? "Save changes" : "Save entry"}
        />
      </Stack>
    </form>
  );
}
