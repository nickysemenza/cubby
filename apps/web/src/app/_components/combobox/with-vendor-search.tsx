import type { VendorShortcode } from "@cubby/schemas/identifiers";
import { parseShortcode } from "@cubby/shared";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { toast } from "sonner";
import { useEntityCommands } from "~/entities/editing/use-entity-commands";
import { entityDetailQueryOptions } from "~/entities/entity-detail.functions";
import { useTRPC } from "~/integrations/trpc/react";
import {
  buildSearchHitComboboxItem,
  buildVendorNameComboboxItem,
  buildVendorShortcodeComboboxItem,
} from "./combobox-builders";
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

/** Shared vendor query orchestration for name- and shortcode-valued pickers. */
function useVendorSearchRows() {
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
  const { data: searchHits, isLoading: isSearchLoading } = useQuery({
    ...api.search.find.queryOptions({
      query: searchQuery || "vendor",
      entityTypes: ["vendor"],
      limit: 20,
    }),
    enabled: enabled && !searchingByCode && searchQuery.trim() !== "",
  });
  const { data: exactItem, isLoading: isExactLoading } = useQuery(
    entityDetailQueryOptions("vendor", exactCode ?? "VEN-2222", {
      enabled: exactCode != null,
    }),
  );

  const rows = useMemo(
    () => (searchingByCode ? (exactItem ? [exactItem] : []) : (data ?? [])),
    [data, exactItem, searchingByCode],
  );

  return {
    api,
    rows,
    searchHits,
    isTypedSearch: searchQuery.trim() !== "" && !searchingByCode,
    searchQuery,
    onSearchChange,
    onOpenChange,
    isLoading: exactCode
      ? isExactLoading
      : searchQuery.trim()
        ? isSearchLoading
        : isLoading,
  };
}

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
  const {
    rows,
    searchHits,
    isTypedSearch,
    onSearchChange,
    onOpenChange,
    isLoading,
  } = useVendorSearchRows();

  const items = useMemo<ComboboxItem<VendorName>[]>(() => {
    // Destructuring the real `id` here while the item's own `id` stays the
    // NAME (per this module's doc above) looks like a bug — it isn't. The
    // combobox item's identity is deliberately the name; `id` is consumed only
    // by the icon, to resolve a rename-proof logo via `VendorMark`'s
    // `vendorId` prop.
    if (!isTypedSearch) return rows.map(buildVendorNameComboboxItem);
    return (searchHits ?? []).map((hit) => {
      const item = buildSearchHitComboboxItem<VendorShortcode>(hit, "vendor");
      return { ...item, id: hit.title };
    });
  }, [isTypedSearch, rows, searchHits]);

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

/** Persisted vendor relation adapter: purchase writes keep VendorShortcode. */
export function WithVendorShortcodeSearch({
  children,
}: WithEntitySearchProps<VendorShortcode>) {
  const {
    rows,
    searchHits,
    isTypedSearch,
    onSearchChange,
    onOpenChange,
    isLoading,
  } = useVendorSearchRows();

  const items = useMemo<ComboboxItem<VendorShortcode>[]>(() => {
    if (!isTypedSearch) return rows.map(buildVendorShortcodeComboboxItem);
    return (searchHits ?? []).map((hit) =>
      buildSearchHitComboboxItem<VendorShortcode>(hit, "vendor"),
    );
  }, [isTypedSearch, rows, searchHits]);

  const commands = useEntityCommands("vendor");
  const onCreateNew = useCallback(
    async (name: string): Promise<ComboboxItem<VendorShortcode>> => {
      const result = await commands.create({
        intent: "capture",
        values: { name: name.trim() },
        surface: "quick-create",
      });
      if (!result.ok || !result.result) {
        const message = result.ok
          ? "Vendor creation returned no record."
          : (result.issues[0]?.message ?? "Failed to create vendor.");
        toast.error(message);
        throw new Error(message);
      }
      toast.success(`Added vendor ${result.result.name}`);
      return buildVendorShortcodeComboboxItem(result.result as never);
    },
    [commands],
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
