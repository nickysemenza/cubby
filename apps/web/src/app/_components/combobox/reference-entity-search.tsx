import { productCategoryShortcode } from "@cubby/schemas/identifiers";
import type { ReactNode } from "react";
import { useCallback, useState } from "react";

import { useProductCategories } from "~/app/_components/hooks/useProductCategories";
import {
  WithFinancialAccountSearch,
  WithPurchaseSearch,
} from "~/app/finance/financial-selectors";

import type { PickerEntity } from "./combobox-types";
import {
  WithEntitySearch,
  type WithEntitySearchProps,
} from "./with-search-hook";
import { WithVendorShortcodeSearch } from "./with-vendor-search";

function WithProductCategorySearch({
  children,
}: WithEntitySearchProps<string>) {
  const [query, setQuery] = useState("");
  const { categories, isLoading } = useProductCategories();
  const onSearchChange = useCallback((next: string) => setQuery(next), []);
  return children({
    items: categories
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
          .includes(query.toLowerCase()),
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
      }),
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
  "planting",
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
    case "financialAccount":
      // SAFETY: the provider's branded shortcode is a string at this generic
      // manifest boundary; EntityPicker preserves it back to the mutation.
      return WithFinancialAccountSearch as never;
    case "purchase":
      // SAFETY: see financialAccount — the reference mutation accepts the
      // manifest's string identifier and server validation remains final.
      return WithPurchaseSearch as never;
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
