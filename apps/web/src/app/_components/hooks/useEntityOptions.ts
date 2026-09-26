import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";
import type {
  FilterOptionItem,
  FilterOptionProjection,
} from "@cubby/schemas/filter-options";
import type { ExpenseShortcode } from "@cubby/schemas/identifiers";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { entityFilterOptions } from "~/entities/entity-filter-options.functions";

const NO_ITEMS: FilterOptionItem[] = [];

/**
 * The whole (small, personal-household) roster for a shortcode entity, with
 * optional per-row projections (`count`, `logo`, `kind`, `icon`, `dates`) —
 * the one client integration point over `getFilterOptions` for a
 * picker/chart that wants every row up front, unlike the search-as-you-type
 * combobox path (`useEntityListSource`). Replaces the former
 * `project.options`/`ledgerParty.options` procedures.
 */
export function useEntityOptions(
  entity: ShortcodeEntity,
  options: {
    include?: readonly FilterOptionProjection[];
    /** See `filterOptionsInput`'s `excludeExpenseId` (project `dates` only). */
    excludeExpenseId?: ExpenseShortcode;
    /** False skips the request — a value already known elsewhere. */
    enabled?: boolean;
  } = {},
) {
  const { include = [], excludeExpenseId, enabled = true } = options;
  const query = useQuery({
    ...entityFilterOptions.filterOptions.queryOptions({
      source: "entity",
      entity,
      search: "",
      selectedIds: [],
      include: [...include],
      limit: 1000,
      excludeExpenseId,
    }),
    enabled,
  });
  return {
    items: query.data?.items ?? NO_ITEMS,
    isLoading: query.isLoading,
  };
}

const NO_TAG_OPTIONS: Array<{ value: string; label: string }> = [];

/**
 * The recipe/product tag universe as `{value,label}` options — feeds each
 * list's Tags filter (`optionsKey: "tags"`). Product tags carry a usage
 * count baked into the label (unlike recipe tags): with free-text tags the
 * count is what exposes a near-duplicate ("M18 (13)" next to a stray "m18
 * (1)") before it spreads. Replaces `recipe.getAllTags`/`product.tagOptions`.
 */
export function useTagOptions(entity: "recipe" | "product") {
  const query = useQuery(
    entityFilterOptions.filterOptions.queryOptions({
      source: "tags",
      entity,
      search: "",
      selectedIds: [],
      limit: 1000,
    }),
  );
  const options = useMemo(
    () =>
      query.data?.items.map((item) => ({
        value: item.id,
        label:
          item.count !== undefined
            ? `${item.label} (${item.count})`
            : item.label,
      })) ?? NO_TAG_OPTIONS,
    [query.data],
  );
  return { options, isLoading: query.isLoading };
}
