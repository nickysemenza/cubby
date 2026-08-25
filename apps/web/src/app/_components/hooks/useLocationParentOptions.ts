import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { locationParentOptionsQueryOptions } from "~/app/locations/location.functions";
import type { FilterableComboboxItem } from "~/components/ui/combobox";

const NO_PARENT_LOCATION_OPTIONS: FilterableComboboxItem[] = [];

/**
 * Locations with at least one live child, as `{value,label}` options —
 * feeds the location list's Parent filter (`optionsKey: "parentLocation"`).
 * Backed by the bounded `location.parentOptions` procedure (only locations
 * that can actually match, not the full ~136-row roster) — see
 * repo/location/lookup.ts's `locationParentOptions`.
 */
export function useLocationParentOptions() {
  const { data, isLoading } = useQuery(locationParentOptionsQueryOptions());

  const options = useMemo<FilterableComboboxItem[]>(
    () =>
      data?.map((location) => ({
        value: location.id as string,
        label: location.name,
        detail: location.ancestors.map((a) => a.name).join(" › ") || undefined,
      })) ?? NO_PARENT_LOCATION_OPTIONS,
    [data],
  );

  return { options, isLoading };
}
