import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";
import type {
  FilterOptionItem,
  FilterOptionProjection,
  FilterOptionsInput,
} from "@cubby/schemas/filter-options";
import type { ExpenseShortcode } from "@cubby/schemas/identifiers";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { useLoadAllPages } from "~/entity/hooks/use-all-entity-records";
import { cursorQueryOptions } from "~/integrations/tanstack-query/cursor-query-options";
import { entityFilterOptions } from "~/integrations/tanstack-query/generated/domains/entityFilterOptions.gen";

const NO_ITEMS: FilterOptionItem[] = [];

/**
 * The whole (small, personal-household) roster for a shortcode entity, with
 * optional per-row projections (`count`, `logo`, `kind`, `emoji`, `dates`) —
 * the one client integration point over `getFilterOptions` for a
 * chart that needs a complete identity map, unlike the search-as-you-type
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
  const query = useInfiniteQuery({
    ...cursorQueryOptions(entityFilterOptions.filterOptions, {
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
  useLoadAllPages(query, enabled);
  const items = useMemo(
    () => query.data?.pages.flatMap((page) => page.items) ?? NO_ITEMS,
    [query.data],
  );
  return {
    items,
    isLoading:
      enabled &&
      !query.isError &&
      (query.isPending || query.hasNextPage || query.isFetchingNextPage),
    error: query.error,
    onRetry: () => {
      void query.refetch();
    },
  };
}

const NO_TAG_OPTIONS: Array<{ value: string; label: string }> = [];

/**
 * The recipe/product tag universe as `{value,label}` options — feeds each
 * list's Tags filter (`optionsKey: "tags"`). Product tags carry a usage
 * count alongside the label (unlike recipe tags): with free-text tags the
 * count is what exposes a near-duplicate ("M18 (13)" next to a stray "m18
 * (1)") before it spreads. Replaces `recipe.getAllTags`/`product.tagOptions`.
 */
export function useTagOptions(
  entity: Extract<FilterOptionsInput, { source: "tags" }>["entity"],
  enabled = true,
) {
  const query = useInfiniteQuery({
    ...cursorQueryOptions(entityFilterOptions.filterOptions, {
      source: "tags",
      entity,
      search: "",
      selectedIds: [],
      limit: 1000,
    }),
    enabled,
  });
  useLoadAllPages(query, enabled);
  const options = useMemo(
    () =>
      query.data?.pages
        .flatMap((page) => page.items)
        .map((item) => ({
          value: item.id,
          label: item.label,
          hint: item.count === undefined ? undefined : String(item.count),
        })) ?? NO_TAG_OPTIONS,
    [query.data],
  );
  return {
    options,
    isLoading:
      enabled &&
      !query.isError &&
      (query.isPending || query.hasNextPage || query.isFetchingNextPage),
    error: query.error,
    onRetry: () => {
      void query.refetch();
    },
  };
}
