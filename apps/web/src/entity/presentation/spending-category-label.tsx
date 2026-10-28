import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import { EntityPill } from "~/entity/components/entity-pill";
import { EntityRefLink } from "~/entity/components/entity-ref-link";
import { compileEntityListInput } from "~/entity/entity-list";
import { useServerTree } from "~/entity/hooks/use-server-tree";
import { useEntityMetadata } from "~/entity/metadata";
import { NoneValue } from "~/ui/primitives/none-value";

// One cached hierarchy read shared by every pill on the page.
const spendingCategoryTreeInput = (queryClient: QueryClient) =>
  compileEntityListInput(
    queryClient,
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
  const queryClient = useQueryClient();
  useEntityMetadata("spendingCategory");
  const input = useMemo(
    () => spendingCategoryTreeInput(queryClient),
    [queryClient],
  );
  const { tree } = useServerTree("spendingCategory", input);
  const resolved = useMemo(
    () => (id && tree ? findSpendingCategory(tree, id) : null),
    [tree, id],
  );
  const label = resolved?.path.join(" / ") || name || id;
  if (!label) return <NoneValue />;
  const mark = resolved?.emoji ?? emoji;
  return id ? (
    <EntityRefLink
      entity="spendingCategory"
      id={id}
      name={label}
      emoji={mark}
    />
  ) : (
    <EntityPill
      entity="spendingCategory"
      id=""
      name={label}
      emoji={mark}
      displayImage={null}
    />
  );
}
