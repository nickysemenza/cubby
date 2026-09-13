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
import { NativeSelect } from "~/components/ui/native-select";
import { ripple } from "~/integrations/tanstack-query/cache-tags";
import { getErrorMessage } from "~/lib/error-utils";
import { householdLocalDate } from "~/lib/household-date";

import { GardenField, GardenFormActions, GardenNotes } from "./garden-fields";
import { GardenPicker } from "./garden-picker";
import { garden } from "./garden.functions";

export type PlantingAction = "start" | "move" | "split" | "finish";
export const plantingActionLabels = {
  start: "Start planting",
  move: "Move everything",
  split: "Move some seedlings",
  finish: "Finish planting",
};

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
            label={action === "start" ? "Starting location" : "Destination"}
            value={location}
            onChange={setLocation}
          />
        )}
        <GardenField
          label="Date"
          type="date"
          value={date}
          onChange={setDate}
          required
        />
        {action === "start" && (
          <Stack gap="sm">
            <label htmlFor="garden-start-method">How are you starting?</label>
            <NativeSelect
              id="garden-start-method"
              value={startMethod}
              onChange={(event) => setStartMethod(event.target.value)}
            >
              <option value="sow">Sowing seeds</option>
              <option value="transplant">Planting a seedling or plant</option>
              <option value="existing">Already growing; date unknown</option>
            </NativeSelect>
          </Stack>
        )}
        {action === "split" && (
          <>
            <GardenField
              label="Quantity being moved (optional)"
              value={quantity}
              onChange={setQuantity}
              placeholder="A few seedlings"
            />
            <p className="text-sm text-muted-foreground">
              Remaining seedlings stay in the original location. The new
              planting keeps the seed source and sowing history.
            </p>
          </>
        )}
        {action === "finish" && (
          <p className="text-sm text-muted-foreground">
            This finishes only this planting. Its photos and harvest history
            stay available.
          </p>
        )}
        {action !== "start" && <GardenNotes value={note} onChange={setNote} />}
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
