import { useQuery } from "@tanstack/react-query";
import { useId } from "react";

import type { ComboboxItem } from "~/app/_components/combobox/combobox-types";
import { EntityPicker } from "~/app/_components/combobox/entity-picker";
import { Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { Label } from "~/components/ui/label";

import { garden } from "./garden.functions";

const wholeLocation = {
  id: "whole-location",
  name: "Whole bed or growing area",
};

export function EntryContextFields({
  location,
  planting,
  onLocationChange,
  onPlantingChange,
  disabled,
  loadOptions = garden.options,
}: {
  location: ComboboxItem | null;
  planting: ComboboxItem | null;
  onLocationChange: (value: ComboboxItem | null) => void;
  onPlantingChange: (value: ComboboxItem | null) => void;
  disabled: boolean;
  loadOptions?: typeof garden.options;
}) {
  const options = useQuery(loadOptions.queryOptions(undefined));
  const locationInput = useId();
  const plantingInput = useId();
  const locations = options.data?.locations ?? [];
  const plantings = options.data?.plantings ?? [];
  const resolvedLocation =
    locations.find((item) => item.id === location?.id) ?? location;
  const resolvedPlanting =
    plantings.find((item) => item.id === planting?.id) ?? planting;
  return (
    <Stack gap="md">
      <Stack gap="sm">
        <Label htmlFor={locationInput}>Location where this happened</Label>
        <EntityPicker
          inputId={locationInput}
          entity="location"
          label="Location where this happened"
          items={locations}
          value={resolvedLocation}
          setValue={onLocationChange}
          disabled={disabled}
          isLoading={options.isPending}
        />
      </Stack>
      <Stack gap="sm">
        <Label htmlFor={plantingInput}>About</Label>
        <EntityPicker
          inputId={plantingInput}
          label="About"
          items={[
            wholeLocation,
            ...plantings.map((item) => ({
              id: item.id,
              name: item.name,
              secondary: [item.locationName, item.status]
                .filter(Boolean)
                .join(" · "),
            })),
          ]}
          value={resolvedPlanting ?? wholeLocation}
          setValue={(value) =>
            onPlantingChange(value?.id === wholeLocation.id ? null : value)
          }
          disabled={disabled}
          isLoading={options.isPending}
        />
        <p className="text-sm text-muted-foreground">
          {planting
            ? "This entry stays in this planting’s journal, even after it moves."
            : "Shared with plantings known to be here on the observation date. Unknown earlier dates are not assumed."}
        </p>
      </Stack>
      {options.isError && (
        <p className="text-sm text-destructive">
          Could not load locations and plantings.{" "}
          <Button
            type="button"
            variant="ghost"
            onClick={() => void options.refetch()}
          >
            Retry
          </Button>
        </p>
      )}
    </Stack>
  );
}
