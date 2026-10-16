import type { GeneratedGroupChoice } from "@cubby/schemas/entity-list-fields";
import { FILTER_NONE } from "@cubby/schemas/filter-sentinel-fields";
import type { ListGroupSummary } from "@cubby/schemas/pagination";
import { useMemo } from "react";

/**
 * A list grouped by a declared `model.grouping` choice. `groups` are the
 * server's sections of the whole filtered set, in page order; `onFilter` sets
 * a section's value as the field's include filter, present only when the
 * field has a declared filter.
 */
export interface GroupConfig {
  choice: GeneratedGroupChoice;
  groups: readonly ListGroupSummary[];
  onFilter?: (key: string) => void;
}

export interface GroupSection<T> {
  key: string;
  label: string;
  /** The section's rows in the whole filtered set, loaded or not. */
  count: number;
  items: T[];
  /** Applies "Filter to this"; absent when the section has no filter value. */
  onFilter?: () => void;
}

/**
 * The loaded rows split into the server's sections. The page and summary
 * queries share one total order, so loaded rows are a prefix of the sections:
 * each section takes its next `count` rows. A section with no loaded row yet
 * is omitted. `isNested` rows (a tree's children) follow their parent without
 * taking a place.
 */
export function groupSections<T>(
  items: readonly T[],
  config: GroupConfig,
  isNested: (item: T) => boolean = () => false,
): GroupSection<T>[] {
  const sections: GroupSection<T>[] = [];
  let index = 0;
  for (const group of config.groups) {
    if (index >= items.length) break;
    const section: GroupSection<T> = {
      key: group.key,
      label: group.label,
      count: group.count,
      items: [],
      onFilter:
        config.onFilter &&
        (group.key !== FILTER_NONE || config.choice.filter?.noValue)
          ? () => config.onFilter?.(group.key)
          : undefined,
    };
    let taken = 0;
    while (index < items.length) {
      const item = items[index]!;
      if (!isNested(item)) {
        if (taken === group.count) break;
        taken += 1;
      }
      section.items.push(item);
      index += 1;
    }
    sections.push(section);
  }
  return sections;
}

export type GroupedVirtualItem<TItem> =
  | { kind: "header"; section: GroupSection<TItem> }
  | { kind: "row"; item: TItem };

export function useGroupedList<TItem>(
  data: TItem[],
  groupConfig: GroupConfig | undefined,
  isNested?: (item: TItem) => boolean,
): GroupedVirtualItem<TItem>[] | null {
  return useMemo(() => {
    if (!groupConfig) return null;
    return groupSections(data, groupConfig, isNested).flatMap(
      (section): GroupedVirtualItem<TItem>[] => [
        { kind: "header", section },
        ...section.items.map((item) => ({ kind: "row" as const, item })),
      ],
    );
  }, [data, groupConfig, isNested]);
}
