import type { VendorShortcode } from "@cubby/schemas/identifiers";
import { parseShortcode } from "@cubby/shared";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { useActionMutation } from "~/app/_components/hooks/useActionMutation";
import { useTRPC } from "~/integrations/trpc/react";
import { getErrorMessage } from "~/lib/error-utils";
import { vendorMutationInvalidateKeys } from "~/lib/query-keys";
import {
  buildVendorNameComboboxItem,
  buildVendorShortcodeComboboxItem,
} from "./combobox-builders";
import type { ComboboxItem } from "./combobox-types";
import {
  pagination,
  useDeferredSearch,
  useEntitySearch,
} from "./entity-search-hooks";
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
 * Vendor roster picker. Opening with a blank query uses the compact popularity-
 * ordered options list; typed queries use the server search so notes and sites
 * participate alongside names and shortcodes.
 *
 * Server order is charge-count desc, then name — the vendors you actually buy
 * from float to the top of an unfiltered picker, which is the whole point of
 * offering the roster.
 *
 * Unlike the entity pickers, "create new" needs no `create` mutation: a name
 * that matches nothing on the roster IS the new vendor, and the save that
 * follows mints the row via `findOrCreateVendor`. `EntityPicker`
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

  const parsedCode = parseShortcode(searchQuery);
  const exactCode = parsedCode?.type === "vendor" ? parsedCode.shortcode : null;
  const searchingByCode = parsedCode != null;

  const { data, isLoading } = useQuery({
    ...api.vendor.options.queryOptions(),
    enabled: enabled && !searchingByCode && searchQuery.trim() === "",
  });
  const { data: searchData, isLoading: isSearchLoading } = useQuery({
    ...api.vendor.list.queryOptions({
      filters: { search: searchQuery },
      pagination,
    }),
    enabled: enabled && !searchingByCode && searchQuery.trim() !== "",
  });
  const { data: exactItem, isLoading: isExactLoading } = useQuery(
    api.vendor.getByShortcode.queryOptions(
      { shortcode: exactCode ?? "VEN-2222" },
      { enabled: exactCode != null },
    ),
  );

  const items = useMemo<ComboboxItem<VendorName>[]>(() => {
    // Destructuring the real `id` here while the item's own `id` stays the
    // NAME (per this module's doc above) looks like a bug — it isn't. The
    // combobox item's identity is deliberately the name; `id` is consumed only
    // by the icon, to resolve a rename-proof logo via `VendorMark`'s
    // `vendorId` prop.
    if (searchingByCode) {
      return exactItem ? [buildVendorNameComboboxItem(exactItem)] : [];
    }
    const roster = searchQuery.trim() ? searchData?.items : data;
    return roster?.map(buildVendorNameComboboxItem) ?? [];
  }, [data, exactItem, searchData, searchQuery, searchingByCode]);

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
        isLoading: exactCode
          ? isExactLoading
          : searchQuery.trim()
            ? isSearchLoading
            : isLoading,
        onCreateNew,
        onOpenChange,
      })}
    </>
  );
}

/** Persisted vendor relation adapter: purchase writes keep VendorShortcode. */
export function WithVendorShortcodeSearch({
  children,
}: WithEntitySearchProps<VendorShortcode>) {
  const api = useTRPC();
  const { searchQuery, onSearchChange } = useEntitySearch();
  const { enabled, onOpenChange } = useDeferredSearch(searchQuery);
  const parsedCode = parseShortcode(searchQuery);
  const exactCode = parsedCode?.type === "vendor" ? parsedCode.shortcode : null;
  const searchingByCode = parsedCode != null;

  const { data, isLoading } = useQuery({
    ...api.vendor.options.queryOptions(),
    enabled: enabled && !searchingByCode && searchQuery.trim() === "",
  });
  const { data: searchData, isLoading: isSearchLoading } = useQuery({
    ...api.vendor.list.queryOptions({
      filters: { search: searchQuery },
      pagination,
    }),
    enabled: enabled && !searchingByCode && searchQuery.trim() !== "",
  });
  const { data: exactItem, isLoading: isExactLoading } = useQuery(
    api.vendor.getByShortcode.queryOptions(
      { shortcode: exactCode ?? "VEN-2222" },
      { enabled: exactCode != null },
    ),
  );

  const items = useMemo<ComboboxItem<VendorShortcode>[]>(() => {
    const rows = searchingByCode
      ? exactItem
        ? [exactItem]
        : []
      : searchQuery.trim()
        ? (searchData?.items ?? [])
        : (data ?? []);
    return rows.map(buildVendorShortcodeComboboxItem);
  }, [data, exactItem, searchData, searchQuery, searchingByCode]);

  const createMutation = useActionMutation({
    mutationFn: api.vendor.create.mutationOptions,
    success: (vendor) => `Added vendor ${vendor.name}`,
    invalidateKeys: vendorMutationInvalidateKeys,
    error: (error) => `Failed to create vendor: ${getErrorMessage(error)}`,
  });
  const onCreateNew = useCallback(
    async (name: string): Promise<ComboboxItem<VendorShortcode>> => {
      const vendor = await createMutation.mutateAsync({
        name: name.trim(),
        website: null,
        notes: null,
      });
      return buildVendorShortcodeComboboxItem(vendor);
    },
    [createMutation],
  );

  return (
    <>
      {children({
        items,
        onSearchChange,
        isLoading: exactCode
          ? isExactLoading
          : searchQuery.trim()
            ? isSearchLoading
            : isLoading,
        onCreateNew,
        onOpenChange,
      })}
    </>
  );
}
