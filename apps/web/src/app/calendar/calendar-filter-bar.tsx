import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { ManifestFilterBar } from "~/app/_components/data-table/ManifestFilterBar";
import { useFilterOptions } from "~/app/_components/hooks/useFilterOptions";
import { useProjectOptions } from "~/app/_components/hooks/useProjectOptions";
import { VendorMark } from "~/components/entity/vendor-cell";
import type { FilterableComboboxItem } from "~/components/ui/combobox";
import { useTRPC } from "~/integrations/trpc/react";
import { calendarFilterSpecs } from "./calendar-filter-specs";

// Stable empty default — an inline `?? []` would allocate a fresh array every
// render while the query loads, destabilizing the `useFilterOptions` chain
// below it (apps/web/CLAUDE.md, `unstable-hook-default`).
const NO_VENDOR_OPTIONS: FilterableComboboxItem[] = [];

interface CalendarFilterBarProps {
  search: Record<string, unknown>;
  onSearchChange: (params: Record<string, string | undefined>) => void;
}

/** Supplies the calendar's runtime picklists to the shared manifest bar. */
export function CalendarFilterBar({
  search,
  onSearchChange,
}: CalendarFilterBarProps) {
  const api = useTRPC();
  const { options: projectOptions } = useProjectOptions();
  const vendorOptionsQuery = useQuery(api.expense.vendorOptions.queryOptions());
  const vendorOptions = useMemo<FilterableComboboxItem[]>(
    () =>
      vendorOptionsQuery.data?.map(({ id, name, count }) => ({
        value: id,
        label: name,
        hint: String(count),
        icon: <VendorMark vendor={name} vendorId={id} />,
      })) ?? NO_VENDOR_OPTIONS,
    [vendorOptionsQuery.data],
  );
  const filterOptions = useFilterOptions({
    project: projectOptions,
    vendor: vendorOptions,
  });

  return (
    <ManifestFilterBar
      specs={calendarFilterSpecs}
      filterOptions={filterOptions}
      search={search}
      onSearchChange={onSearchChange}
    />
  );
}
