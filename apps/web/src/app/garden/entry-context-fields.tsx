import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";

import type { ComboboxItem } from "~/app/_components/combobox/combobox-types";
import { EntityPicker } from "~/app/_components/combobox/entity-picker";
import { Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { Label } from "~/components/ui/label";

import { gardenStrings } from "./garden-strings";
import { garden } from "./garden.functions";

const wholeLocation = {
  id: "whole-location",
  name: gardenStrings.location.wholeArea,
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
  const [search, setSearch] = useState("");
  const options = useQuery(loadOptions.queryOptions(search ? { search } : {}));
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
        <Label htmlFor={locationInput}>
          {gardenStrings.entry.locationField}
        </Label>
        <EntityPicker
          inputId={locationInput}
          entity="location"
          label={gardenStrings.entry.locationField}
          items={locations}
          value={resolvedLocation}
          setValue={onLocationChange}
          onSearchChange={setSearch}
          disabled={disabled}
          isLoading={options.isPending}
        />
      </Stack>
      <Stack gap="sm">
        <Label htmlFor={plantingInput}>{gardenStrings.entry.aboutField}</Label>
        <EntityPicker
          inputId={plantingInput}
          label={gardenStrings.entry.aboutField}
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
            ? gardenStrings.entry.aboutHelpWithPlanting
            : gardenStrings.entry.aboutHelpWithoutPlanting}
        </p>
      </Stack>
      {options.isError && (
        <p className="text-sm text-destructive">
          {gardenStrings.entry.loadFailed}{" "}
          <Button
            type="button"
            variant="ghost"
            onClick={() => void options.refetch()}
          >
            {gardenStrings.common.retry}
          </Button>
        </p>
      )}
    </Stack>
  );
}
