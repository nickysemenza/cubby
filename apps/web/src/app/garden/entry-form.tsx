import {
  gardenEntryUpdateData,
  gardenRecordEntryInput,
  type GardenEntryOut,
} from "@cubby/schemas/garden";
import { imageShortcode } from "@cubby/schemas/identifiers";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";

import { Grid, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { Image } from "~/components/ui/image";
import { NativeSelect } from "~/components/ui/native-select";
import { entityMutation } from "~/entities/entity-mutation.functions";
import { ripple } from "~/integrations/tanstack-query/cache-tags";
import { getErrorMessage } from "~/lib/error-utils";
import { householdLocalDate } from "~/lib/household-date";

import { GardenField, GardenFormActions, GardenNotes } from "./garden-fields";
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
export function EntryForm({
  locationId,
  plantingId,
  entry,
  onSaved,
  onCancel,
  operations = productionOperations,
}: {
  locationId: string;
  plantingId?: string;
  entry?: GardenEntryOut;
  onSaved: () => void;
  onCancel: () => void;
  operations?: typeof productionOperations;
}) {
  const [kind, setKind] = useState(entry?.kind ?? "observation");
  const [observedOn, setObservedOn] = useState(
    entry?.observedOn ?? householdLocalDate(),
  );
  const [note, setNote] = useState(entry?.note ?? "");
  const [harvestAmount, setHarvestAmount] = useState(
    entry?.harvestAmount ?? "",
  );
  const [photos, setPhotos] = useState<GardenPhotoDraft[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [removedImages, setRemovedImages] = useState<string[]>([]);
  // Saving the batch is deliberately sequential: failed uploads leave both the form and completed uploads intact.
  const save = useMutation({
    meta: { invalidates: ripple.garden },
    mutationFn: async () => {
      const data = {
        locationId: entry?.locationId ?? locationId,
        plantingId: entry?.plantingId ?? plantingId ?? null,
        kind,
        observedOn,
        note: note.trim() || null,
        harvestAmount: kind === "harvest" ? harvestAmount.trim() || null : null,
      };
      const pendingImageIds = await uploadGardenPhotos(photos);
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
            disabled={entry?.kind === "move"}
          >
            <option value="observation">Note or photos</option>
            <option value="harvest">Harvest</option>
            {entry?.kind === "move" && <option value="move">Move</option>}
          </NativeSelect>
        </Stack>
        <GardenField
          label="Observation date"
          type="date"
          value={observedOn}
          onChange={setObservedOn}
          required
        />
        {kind === "harvest" && (
          <GardenField
            label="Harvest amount (optional)"
            value={harvestAmount}
            onChange={setHarvestAmount}
            placeholder="A handful, 6 tomatoes, 300 g…"
          />
        )}
        <GardenNotes value={note} onChange={setNote} />
        {entry && entry.images.length > 0 && (
          <Grid cols="pair" gap="md">
            {entry.images
              .filter((image) => !removedImages.includes(image.id))
              .map((image) => (
                <Stack key={image.id} gap="sm">
                  <a href={image.url} target="_blank" rel="noreferrer">
                    <Image
                      src={image.url}
                      alt="Garden observation"
                      displayWidth={240}
                      className="h-40 w-full rounded-md object-contain"
                    />
                  </a>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={save.isPending}
                    onClick={() =>
                      setRemovedImages((current) => [...current, image.id])
                    }
                  >
                    Remove photo
                  </Button>
                </Stack>
              ))}
          </Grid>
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
