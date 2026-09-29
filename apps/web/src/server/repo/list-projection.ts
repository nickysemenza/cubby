import type { projectListRows } from "~/entities/list-read-schema";

import { traceListGroup } from "./list-read-tracing";

export type ListReadRow = ReturnType<typeof projectListRows>[number];

export type ListEnrichmentGroup = "quality" | "media" | "relations" | "derived";

export interface ListProjection {
  kind: "full" | "base" | "enrichment";
  groups?: readonly ListEnrichmentGroup[];
}

export const wantsListGroup = (
  projection: ListProjection,
  group: ListEnrichmentGroup,
): boolean =>
  projection.kind === "full" ||
  (projection.kind === "enrichment" &&
    projection.groups?.includes(group) === true);

/** A dependency shared by several groups is one loader, gated by its consumers. */
export const loadListGroup = async <T>(
  projection: ListProjection,
  groups: ListEnrichmentGroup | readonly ListEnrichmentGroup[],
  load: () => Promise<T>,
): Promise<T | undefined> =>
  [groups].flat().some((group) => wantsListGroup(projection, group))
    ? traceListGroup(groups, load)
    : undefined;

/** Build only the selected group's columns or canonical fields; omitted groups stay absent. */
export const listGroupFields = <T extends object>(
  projection: ListProjection,
  groups: ListEnrichmentGroup | readonly ListEnrichmentGroup[],
  build: () => T,
): Partial<T> => {
  if ([groups].flat().some((group) => wantsListGroup(projection, group)))
    return build();
  return {};
};

/** Dependencies precede consumers, even when several consumers share them. */
export function expandListGroups(
  groups: readonly ListEnrichmentGroup[],
  dependencies: Partial<
    Record<ListEnrichmentGroup, readonly ListEnrichmentGroup[]>
  >,
): ListEnrichmentGroup[] {
  const ordered: ListEnrichmentGroup[] = [];
  const visited = new Set<ListEnrichmentGroup>();
  const active = new Set<ListEnrichmentGroup>();
  const visit = (group: ListEnrichmentGroup) => {
    if (active.has(group))
      throw new Error(`List loader dependency cycle: ${group}`);
    if (visited.has(group)) return;
    active.add(group);
    for (const dependency of dependencies[group] ?? []) visit(dependency);
    active.delete(group);
    visited.add(group);
    ordered.push(group);
  };
  for (const group of groups) visit(group);
  return ordered;
}
