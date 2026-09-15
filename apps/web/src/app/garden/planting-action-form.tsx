import {
  gardenFinishPlantingInput,
  gardenMovePlantingInput,
  gardenSplitPlantingInput,
  gardenStartPlantingInput,
  type PlantingOut,
} from "@cubby/schemas/garden";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";

import type { ComboboxItem } from "~/app/_components/combobox/combobox-types";
import { Stack } from "~/components/layout";
import { Label } from "~/components/ui/label";
import { NativeSelect } from "~/components/ui/native-select";
import { ripple } from "~/integrations/tanstack-query/cache-tags";
import { getErrorMessage } from "~/lib/error-utils";
import { householdLocalDate } from "~/lib/household-date";

import {
  GARDEN_DIALOG_FORM_ID,
  GardenField,
  GardenFormActions,
  GardenNotes,
} from "./garden-fields";
import { GardenPicker } from "./garden-picker";
import { gardenStrings } from "./garden-strings";
import { garden } from "./garden.functions";

export type PlantingAction = "start" | "move" | "split" | "finish";
/** Each verb is simultaneously the triggering action, the dialog title, and the submit label. */
export const plantingActionLabels = gardenStrings.planting.verbs;

export function PlantingActionForm({
  planting,
  action,
  onSaved,
  onCancel,
}: {
  planting: PlantingOut;
  action: PlantingAction;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [location, setLocation] = useState<ComboboxItem | null>(null);
  const [date, setDate] = useState(householdLocalDate);
  const [startMethod, setStartMethod] = useState("sow");
  const [quantity, setQuantity] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    meta: { invalidates: ripple.garden },
    mutationFn: async () => {
      const common = {
        plantingId: planting.id,
        locationId: location?.id,
        movedOn: date,
        note: note.trim() || null,
      };
      switch (action) {
        case "start":
          return garden.startPlanting.call(
            gardenStartPlantingInput.parse({
              ...common,
              startedOn: date,
              startMethod,
            }),
          );
        case "move":
          return garden.movePlanting.call(
            gardenMovePlantingInput.parse(common),
          );
        case "split":
          return garden.splitPlanting.call(
            gardenSplitPlantingInput.parse({
              ...common,
              quantity: quantity.trim() || null,
            }),
          );
        case "finish":
          return garden.finishPlanting.call(
            gardenFinishPlantingInput.parse({ ...common, finishedOn: date }),
          );
      }
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
        {action !== "finish" && (
          <GardenPicker
            entity="location"
            label={
              action === "start"
                ? gardenStrings.planting.startingLocationField
                : gardenStrings.planting.destinationField
            }
            value={location}
            onChange={setLocation}
          />
        )}
        <GardenField
          label={gardenStrings.planting.dateField}
          type="date"
          value={date}
          onChange={setDate}
          required
        />
        {action === "start" && (
          <Stack gap="sm">
            <Label htmlFor="garden-start-method">
              {gardenStrings.planting.startMethodField}
            </Label>
            <NativeSelect
              id="garden-start-method"
              value={startMethod}
              onChange={(event) => setStartMethod(event.target.value)}
            >
              <option value="sow">
                {gardenStrings.planting.startMethodSow}
              </option>
              <option value="transplant">
                {gardenStrings.planting.startMethodTransplant}
              </option>
              <option value="existing">
                {gardenStrings.planting.startMethodExisting}
              </option>
            </NativeSelect>
          </Stack>
        )}
        {action === "split" && (
          <>
            <GardenField
              label={gardenStrings.planting.splitQuantityField}
              value={quantity}
              onChange={setQuantity}
              placeholder={gardenStrings.planting.quantityPlaceholder}
            />
            <p className="text-sm text-muted-foreground">
              {gardenStrings.planting.splitExplanation}
            </p>
          </>
        )}
        {action === "finish" && (
          <p className="text-sm text-muted-foreground">
            {gardenStrings.planting.finishExplanation}
          </p>
        )}
        <GardenNotes value={note} onChange={setNote} />
        <GardenFormActions
          pending={save.isPending}
          error={error}
          onCancel={onCancel}
          label={plantingActionLabels[action]}
        />
      </Stack>
    </form>
  );
}
