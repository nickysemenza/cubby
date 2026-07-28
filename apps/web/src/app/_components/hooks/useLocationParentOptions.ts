import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { useTRPC } from "~/integrations/trpc/react";

const NO_PARENT_LOCATION_OPTIONS: Array<{ value: string; label: string }> = [];

/**
 * Locations with at least one live child, as `{value,label}` options —
 * feeds the location list's Parent filter (`optionsKey: "parentLocation"`).
 * Backed by the bounded `location.parentOptions` procedure (only locations
 * that can actually match, not the full ~136-row roster) — see
 * repo/location/lookup.ts's `locationParentOptions`.
 */
export function useLocationParentOptions() {
  const api = useTRPC();
  const { data, isLoading } = useQuery(
    api.location.parentOptions.queryOptions(),
  );

  const options = useMemo(
    () =>
      data?.map((location) => ({
        value: location.id as string,
        label: location.name,
      })) ?? NO_PARENT_LOCATION_OPTIONS,
    [data],
  );

  return { options, isLoading };
}
