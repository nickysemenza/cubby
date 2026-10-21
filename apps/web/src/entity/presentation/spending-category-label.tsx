import { useMemo } from "react";

import { compileEntityListInput } from "~/entity/entity-list";
import { useServerTree } from "~/entity/hooks/use-server-tree";
import { NoneValue } from "~/ui/primitives/none-value";

import { SpendingCategoryPill } from "./spending-category-pill";

// One cached hierarchy read shared by every pill on the page.
const SPENDING_CATEGORY_TREE_INPUT = compileEntityListInput(
  "spendingCategory",
  {},
  { defaultSort: { orderBy: "name", direction: "asc" } },
);

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
 * The one presentation of a spending category value: its emoji and full path
 * on a finance-tinted pill that opens the category. A known `name` and
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
  const { tree } = useServerTree(
    "spendingCategory",
    SPENDING_CATEGORY_TREE_INPUT,
  );
  const resolved = useMemo(
    () => (id && tree ? findSpendingCategory(tree, id) : null),
    [tree, id],
  );
  const label = resolved?.path.join(" / ") || name || id;
  if (!label) return <NoneValue />;
  return (
    <SpendingCategoryPill
      id={id}
      label={label}
      emoji={resolved?.emoji ?? emoji}
    />
  );
}
