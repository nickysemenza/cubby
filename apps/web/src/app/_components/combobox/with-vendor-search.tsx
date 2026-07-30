import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { VendorMark } from "~/components/entity/vendor-cell";
import { useTRPC } from "~/integrations/trpc/react";
import type { ComboboxItem } from "./combobox-types";
import { useDeferredSearch, useEntitySearch } from "./entity-search-hooks";
import type { WithEntitySearchProps } from "./with-search-hook";

/**
 * The vendor picker's items key on the vendor's NAME, not its id.
 *
 * Every write path for a charge's vendor (`expenseUpdateData.vendor`,
 * `purchase-import`, quick-add, MCP) takes a **name** and resolves it server-side
 * through `findOrCreateVendor` — an exact, trimmed, case-SENSITIVE match. That
 * contract is deliberately unchanged, so the picker's job is to make the name it
 * saves come out of the roster verbatim rather than out of the user's keyboard
 * (typing `amazon` next to an existing `Amazon` used to mint a second roster
 * row). Using the name as the `ComboboxItem` id is what lets the generic
 * `EditableEntityCell` machinery — commit-on-pick, optimistic display,
 * re-entrancy guard — carry a name-valued field with no id/name translation
 * layer.
 */
export type VendorName = string;

/**
 * Client-filtered vendor roster picker, same shape as `WithProjectSearch`: the
 * roster is a small personal list (~114 rows), so this fetches
 * `vendor.options` once (deferred until the picker opens) and filters it
 * in-memory as the user types instead of a round trip per keystroke.
 *
 * Server order is charge-count desc, then name — the vendors you actually buy
 * from float to the top of an unfiltered picker, which is the whole point of
 * offering the roster.
 *
 * Unlike the entity pickers, "create new" needs no `create` mutation: a name
 * that matches nothing on the roster IS the new vendor, and the save that
 * follows mints the row via `findOrCreateVendor`. `DialogCompatibleCombobox`
 * only surfaces the create affordance when the typed term matches **no** roster
 * row, so picking an existing vendor stays the default and minting a duplicate
 * takes a name nothing on the roster matches.
 */
export function WithVendorSearch({
  children,
}: WithEntitySearchProps<VendorName>) {
  const api = useTRPC();
  const { searchQuery, onSearchChange } = useEntitySearch();
  const { enabled, onOpenChange } = useDeferredSearch(searchQuery);

  const { data, isLoading } = useQuery({
    ...api.vendor.options.queryOptions(),
    enabled,
  });

  const items = useMemo<ComboboxItem<VendorName>[]>(() => {
    const all =
      data?.map(({ name }) => ({
        id: name,
        name,
        icon: <VendorMark vendor={name} />,
      })) ?? [];
    const query = searchQuery.trim().toLowerCase();
    if (!query) return all;
    return all.filter((item) => item.name.toLowerCase().includes(query));
  }, [data, searchQuery]);

  // No server round trip: the item's id/name IS the typed vendor name, and the
  // roster row is created by the save that follows. Trimmed so a stray space
  // can't produce a "Amazon " that `findOrCreateVendor` reads as a new vendor.
  const onCreateNew = useCallback(
    async (name: string): Promise<ComboboxItem<VendorName>> => {
      const trimmed = name.trim();
      return { id: trimmed, name: trimmed };
    },
    [],
  );

  return (
    <>
      {children({
        items,
        onSearchChange,
        isLoading,
        onCreateNew,
        onOpenChange,
      })}
    </>
  );
}
