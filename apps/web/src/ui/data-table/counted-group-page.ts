import type { ListGroupSummary } from "@cubby/schemas/pagination";

/**
 * Specialized queues page unique queue-item identities in count-ordered
 * sections. Adapt that existing contract without changing entity grouping or
 * treating queue counts as counts of the underlying household records.
 */
export function countedGroupPage({
  groups,
  ids,
  offset,
  totalCount,
}: {
  groups: readonly Pick<ListGroupSummary, "key" | "label" | "count">[];
  ids: readonly string[];
  offset: number;
  totalCount: number;
}) {
  const summaries = groups.map((group) => ({
    ...group,
    key: JSON.stringify([group.key]),
    path: [group.key],
    parentCount: totalCount,
    fraction: totalCount ? group.count / totalCount : null,
    overlapping: false,
  }));
  let sectionIndex = 0;
  let sectionEnd = summaries[0]?.count ?? 0;
  const memberships = ids.map((id, index) => {
    while (offset + index >= sectionEnd && sectionIndex < summaries.length) {
      sectionIndex++;
      sectionEnd += summaries[sectionIndex]?.count ?? 0;
    }
    const group = summaries[sectionIndex];
    if (!group)
      throw new Error(
        "Count-ordered queue sections do not cover the loaded page",
      );
    return { id, path: group.path };
  });
  return { groups: summaries, memberships };
}
