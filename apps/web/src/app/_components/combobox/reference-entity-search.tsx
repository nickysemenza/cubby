import { productCategoryShortcode } from "@cubby/schemas/identifiers";
import type { ReactNode } from "react";
import { useCallback, useMemo, useState } from "react";

import { useProductCategories } from "~/app/_components/hooks/useProductCategories";

import type { ComboboxItem, PickerEntity } from "./combobox-types";
import { treePickerItems } from "./tree-items";
import {
  WithEntitySearch,
  type WithEntitySearchProps,
} from "./with-search-hook";
import { WithVendorShortcodeSearch } from "./with-vendor-search";

/** `useProductCategories()`'s own list row shape — just what the tree/search
 * projections below read off it. */
export interface ProductCategoryRow {
  id: string;
  name: string;
  parentId: string | null;
  aliases: readonly string[];
  description: string | null;
  path: ReadonlyArray<{ id: string; name: string }>;
}

/**
 * The pure "categories + query -> picker items" projection, split out from
 * `WithProductCategorySearch` so it is directly unit-testable — no query
 * client, no React tree. A blank query renders the grouped-list +
 * breadcrumb tree (the whole taxonomy read as a tree rather than 29+
 * same-looking rows); a typed query keeps today's flat full-path search
 * rows, matched against name/aliases/description/path.
 */
export function productCategorySearchItems(
  categories: readonly ProductCategoryRow[],
  query: string,
): ComboboxItem[] {
  if (query.trim() === "") {
    return treePickerItems(categories, {
      idOf: (category) => category.id,
      parentIdOf: (category) => category.parentId,
      labelOf: (category) => category.name,
    });
  }
  const needle = query.toLowerCase();
  return categories
    .filter((category) =>
      [
        category.name,
        ...category.aliases,
        category.description,
        category.path.map((node) => node.name).join(" / "),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(needle),
    )
    .flatMap((category) => {
      const parsedId = productCategoryShortcode.safeParse(category.id);
      if (!parsedId.success) return [];
      return [
        {
          id: parsedId.data,
          name: category.path.map((node) => node.name).join(" / "),
          detail: category.description ?? undefined,
        },
      ];
    });
}

function WithProductCategorySearch({
  children,
}: WithEntitySearchProps<string>) {
  const [query, setQuery] = useState("");
  const { categories, isLoading } = useProductCategories();
  const onSearchChange = useCallback((next: string) => setQuery(next), []);

  const items = useMemo<ComboboxItem[]>(
    () =>
      // SAFETY: `entityListFor("productCategory")` rows always carry these
      // manifest fields (`id`, `name`, `parentId`, `aliases`, `description`,
      // `path`) — narrowed here rather than imported because the generated
      // list-row type is a wide cross-entity union `Map.get` can't index by.
      productCategorySearchItems(categories as ProductCategoryRow[], query),
    [categories, query],
  );

  return children({
    items,
    onSearchChange,
    isLoading,
    onOpenChange: () => {},
  });
}

/** Manifest reference targets with an assignment picker. Multi-value and media
 * relations intentionally stay with their dedicated controls. */
const referencePickerEntities = new Set<PickerEntity>([
  "ingredient",
  "location",
  "product",
  "productCategory",
  "recipe",
  "project",
  "task",
  "vendor",
  "financialAccount",
  "purchase",
  "ledgerParty",
  "plant",
  "planting",
  "vendorAccount",
]);

export const isReferencePickerEntity = (
  entity: string,
): entity is PickerEntity => {
  // SAFETY: Set membership is the runtime proof that this arbitrary string is
  // one of the closed PickerEntity literals.
  return referencePickerEntities.has(entity as PickerEntity);
};

/** One manifest target -> one established picker/search path. The picker is
 * intentionally ID-based at the write boundary; labels are display-only. */
export function referenceEntitySearch(
  entity: PickerEntity,
): (props: WithEntitySearchProps<string>) => ReactNode {
  switch (entity) {
    case "productCategory":
      return WithProductCategorySearch;
    case "vendor":
      // SAFETY: this is the persisted-shortcode vendor provider, not the
      // name-minting picker used by the specialized expense editor.
      return WithVendorShortcodeSearch as never;
    default:
      // SAFETY: the switch removed all specialized providers; remaining
      // PickerEntity literals are exactly WithEntitySearch's entity union.
      return (props) => (
        <WithEntitySearch entity={entity as never} {...props} />
      );
  }
}
