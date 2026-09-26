import {
  parseShortcodeFor,
  type VendorShortcode,
} from "@cubby/schemas/identifiers";
import type { SearchHit } from "@cubby/schemas/search";
import { useQuery } from "@tanstack/react-query";
import { useCallback } from "react";
import { toast } from "sonner";

import { useEntityCommands } from "~/entities/editing/use-entity-commands";
import { entityFilterOptions } from "~/entities/entity-filter-options.functions";

import {
  buildSearchHitComboboxItem,
  buildVendorComboboxItem,
} from "./combobox-builders";
import type { ComboboxItem } from "./combobox-types";
import {
  type EntitySearchScope,
  useEntitySearchRows,
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

type VendorRow = Parameters<typeof buildVendorComboboxItem>[0];

function useVendorListSource(_searchQuery: string, enabled: boolean) {
  const { data, isLoading } = useQuery({
    ...entityFilterOptions.filterOptions.queryOptions({
      source: "entity",
      entity: "vendor",
      // The whole roster, most-purchased first; search filters client-side.
      limit: 1000,
      include: ["count", "logo"],
    }),
    enabled,
    select: (page): VendorRow[] =>
      page.items.map((item) => ({
        id: parseShortcodeFor("vendor", item.id),
        name: item.label,
        count: item.count,
        logo: item.logo,
      })),
  });
  return { data, isLoading };
}

/**
 * Vendor has no shared create dialog: a name that matches no roster row IS
 * the new vendor, so each identity supplies its own `onCreateNew`.
 */
function VendorSearch<TId extends string>({
  build,
  buildSearchHit,
  onCreateNew,
  scope,
  children,
}: {
  build: (row: VendorRow) => ComboboxItem<TId>;
  buildSearchHit: (hit: SearchHit) => ComboboxItem<TId>;
  onCreateNew: (name: string) => Promise<ComboboxItem<TId>>;
  scope?: EntitySearchScope | null;
} & Pick<WithEntitySearchProps<TId>, "children">) {
  const search = useEntitySearchRows(
    "vendor",
    {
      detailPlaceholder: "VEN-2222",
      splitBlankTyped: true,
      useListSource: useVendorListSource,
      build,
      buildDetail: build,
      buildSearchHit,
      useOnCreateNew: () => onCreateNew,
      createNew: "none",
    },
    scope,
  );
  return children({
    items: search.items,
    onSearchChange: search.onSearchChange,
    isLoading: search.isLoading,
    onCreateNew: search.onCreateNew,
    onOpenChange: search.onOpenChange,
  });
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
  scope,
}: WithEntitySearchProps<VendorName>) {
  return (
    <VendorSearch<VendorName>
      build={(row) => buildVendorComboboxItem(row, { itemId: "name" })}
      buildSearchHit={(hit) => {
        // Destructuring the real `id` here while the item's own `id` stays the
        // NAME (per this module's doc above) looks like a bug — it isn't. The
        // combobox item's identity is deliberately the name; `id` is consumed
        // only by the icon, to resolve a rename-proof logo via `VendorMark`'s
        // `vendorId` prop.
        const item = buildSearchHitComboboxItem(hit, "vendor");
        return { ...item, id: hit.title };
      }}
      // No server round trip: the item's id/name IS the typed vendor name, and
      // the roster row is created by the save that follows. Trimmed so a stray
      // space can't produce a "Amazon " that `findOrCreateVendor` reads as a
      // new vendor.
      onCreateNew={async (name) => {
        const trimmed = name.trim();
        return { id: trimmed, name: trimmed };
      }}
      scope={scope}
    >
      {children}
    </VendorSearch>
  );
}

/** Persisted vendor relation adapter: purchase writes keep VendorShortcode. */
export function WithVendorShortcodeSearch({
  children,
  scope,
}: WithEntitySearchProps<VendorShortcode>) {
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
      // EntityEditResultFor deliberately types `id` as a plain string and
      // `name` as optional; this is the ingress where the fresh vendor enters
      // branded-shortcode land, so parse the id for real instead of asserting,
      // and fall back to the name the vendor was created with.
      return buildVendorComboboxItem(
        {
          id: parseShortcodeFor("vendor", result.result.id),
          name: result.result.name ?? name.trim(),
        },
        { itemId: "shortcode" },
      );
    },
    [commands],
  );

  return (
    <VendorSearch<VendorShortcode>
      build={(row) => buildVendorComboboxItem(row, { itemId: "shortcode" })}
      buildSearchHit={(hit) => buildSearchHitComboboxItem(hit, "vendor")}
      onCreateNew={onCreateNew}
      scope={scope}
    >
      {children}
    </VendorSearch>
  );
}
