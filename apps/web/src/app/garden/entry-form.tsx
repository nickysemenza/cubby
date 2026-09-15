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
import { Label } from "~/components/ui/label";
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
  gardenEntryKindLabel,
  uploadGardenPhotos,
  type GardenPhotoDraft,
} from "./garden-photos";
import { gardenStrings } from "./garden-strings";
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

type EntryFieldValues = {
  locationId: string | undefined;
  plantingId: string | null;
  kind: GardenEntryOut["kind"];
  observedOn: string;
  note: string | null;
  harvestAmount: string | null;
};

/**
 * A `move` entry, and the anchor entry `startPlanting` writes when a planting
 * first enters a location, are structural: their location, planting, date,
 * and kind are corrected only through location history, never through this
 * form. See `assertGardenEntryStructure` in `server/repo/garden/index.ts`.
 */
function isEntryLocked(entry: GardenEntryOut | undefined): boolean {
  return entry?.kind === "move" || Boolean(entry?.anchorsPeriod);
}

function entryDateLabel(kind: GardenEntryOut["kind"]): string {
  return kind === "harvest"
    ? gardenStrings.entry.harvestDateField
    : gardenStrings.entry.dateField;
}

/**
 * Only fields the user actually changed go in an update patch — the server
 * treats an omitted (`undefined`) key as untouched, which is what keeps a
 * locked `move`/anchor entry's location, planting, date, and kind intact even
 * though this form always recomputes every field's current value.
 */
function changedEntryFields(
  entry: GardenEntryOut,
  next: EntryFieldValues,
): Partial<EntryFieldValues> {
  const patch: Partial<EntryFieldValues> = {};
  if (next.locationId !== entry.locationId) patch.locationId = next.locationId;
  if (next.plantingId !== (entry.plantingId ?? null))
    patch.plantingId = next.plantingId;
  if (next.kind !== entry.kind) patch.kind = next.kind;
  if (next.observedOn !== entry.observedOn) patch.observedOn = next.observedOn;
  if (next.note !== (entry.note ?? null)) patch.note = next.note;
  if (next.harvestAmount !== (entry.harvestAmount ?? null))
    patch.harvestAmount = next.harvestAmount;
  return patch;
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
  const locked = isEntryLocked(entry);
  const dateLabel = entryDateLabel(kind);
  const kindOptionId = "garden-entry-kind";
  // Saving the batch is deliberately sequential: failed uploads leave both the form and completed uploads intact.
  const save = useMutation({
    meta: { invalidates: ripple.garden },
    mutationFn: async () => {
      const nextValues: EntryFieldValues = {
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
            ...changedEntryFields(entry, nextValues),
            pendingImageIds,
            removeImageIds: removedImages.map((id) => imageShortcode.parse(id)),
          }),
        });
      } else {
        await operations.recordEntry.call(
          gardenRecordEntryInput.parse({ ...nextValues, pendingImageIds }),
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
          disabled={save.isPending || locked}
          loadOptions={loadOptions}
        />
        <Stack gap="sm">
          <Label htmlFor={kindOptionId}>{gardenStrings.entry.kindField}</Label>
          <NativeSelect
            id={kindOptionId}
            value={kind}
            onChange={(event) =>
              setKind(
                event.target.value === "harvest" ? "harvest" : "observation",
              )
            }
            disabled={save.isPending || locked}
          >
            <option value="observation">
              {gardenEntryKindLabel("observation")}
            </option>
            <option value="harvest">{gardenEntryKindLabel("harvest")}</option>
            {locked && entry?.kind === "move" && (
              <option value="move">{gardenEntryKindLabel("move")}</option>
            )}
          </NativeSelect>
        </Stack>
        <GardenField
          label={dateLabel}
          type="date"
          value={observedOn}
          onChange={setObservedOn}
          required
          disabled={save.isPending || locked}
        />
        {locked && (
          <p className="text-sm text-muted-foreground">
            {gardenStrings.entry.moveLockedHint}
          </p>
        )}
        {kind === "harvest" && (
          <GardenField
            label={gardenStrings.entry.harvestAmountField}
            value={harvestAmount}
            onChange={setHarvestAmount}
            placeholder={gardenStrings.entry.harvestAmountPlaceholder}
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
          description={gardenStrings.photos.entryHelp}
        />
        <GardenFormActions
          pending={save.isPending}
          error={error}
          onCancel={onCancel}
          label={gardenStrings.common.saveLabel}
        />
      </Stack>
    </form>
  );
}
