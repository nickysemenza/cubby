import { useMemo } from "react";

import { EntityPill } from "~/entity/components/entity-pill";
import { EntityRefLink } from "~/entity/components/entity-ref-link";
import type { EntityListParams } from "~/entity/entity-list";
import { useServerTree } from "~/entity/hooks/use-server-tree";
import { defaultPagination } from "~/ui/data-table/table-utils";
import { NoneValue } from "~/ui/text/none-value";

import { categoryLeafParts } from "./category-text";

// This shared vocabulary has no route filters. Compiling empty route search
// admitted category metadata from each label and suspended populated lists.
const spendingCategoryTreeInput = {
  filters: {},
  pagination: defaultPagination,
  includeCount: false,
  sort: [{ orderBy: "name", direction: "asc" }],
} satisfies EntityListParams<"spendingCategory">;

type SpendingCategoryTreeRow = {
  id: string;
  name: string;
  emoji?: string | null;
  subRows?: SpendingCategoryTreeRow[];
};

type ResolvedSpendingCategory = {
  path: string[];
  emoji: string | null;
};

function findSpendingCategory(
  rows: readonly SpendingCategoryTreeRow[],
  id: string,
  path: string[] = [],
): ResolvedSpendingCategory | null {
  for (const row of rows) {
    const here = [...path, row.name];
    if (row.id === id) return { path: here, emoji: row.emoji ?? null };
    const nested = row.subRows
      ? findSpendingCategory(row.subRows, id, here)
      : null;
    if (nested) return nested;
  }
  return null;
}

/**
 * A spending category supplies its emoji and full path to the shared identity.
 * A known `name` and
 * `emoji` stand in while the hierarchy loads or when it cannot be read.
 * Without an `id` (a review snapshot that kept only the name) the pill stays
 * unlinked.
 */
export function SpendingCategoryLabel({
  id,
  name,
  emoji,
}: {
  id?: string | null;
  name?: string | null;
  emoji?: string | null;
}) {
  const { tree } = useServerTree("spendingCategory", spendingCategoryTreeInput);
  const resolved = useMemo(
    () => (id && tree ? findSpendingCategory(tree, id) : null),
    [tree, id],
  );
  const { leaf, parent } = categoryLeafParts(
    resolved?.path ?? [],
    name || id || "",
  );
  if (!leaf) return <NoneValue />;
  const mark = resolved?.emoji ?? emoji;
  return id ? (
    <EntityRefLink
      entity="spendingCategory"
      id={id}
      name={leaf}
      parent={parent}
      emoji={mark}
    />
  ) : (
    <EntityPill
      entity="spendingCategory"
      id=""
      name={leaf}
      parent={parent}
      emoji={mark}
      displayImage={null}
    />
  );
}
