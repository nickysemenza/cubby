import type { GeneratedGroupChoice } from "@cubby/schemas/entity-list-fields";
import { FILTER_NONE } from "@cubby/schemas/filter-sentinel-fields";
import type {
  ListGroupMembership,
  ListGroupSummary,
} from "@cubby/schemas/pagination";
import { useMemo, type ReactNode } from "react";

/**
 * A list grouped by a declared `model.grouping` choice. `groups` are the
 * server's sections of the whole filtered set, in page order; `onFilter` sets
 * a section's value as the field's include filter, present only when the
 * field has a declared filter. `hide` returns a section's Hide action (its
 * value as the field's excluded value), or undefined when it cannot hide.
 */
export interface GroupConfig {
  choice: GeneratedGroupChoice;
  groups: readonly ListGroupSummary[];
  memberships: readonly ListGroupMembership[];
  collapsed?: ReadonlySet<string>;
  onToggle?: (key: string) => void;
  onFilter?: (group: ListGroupSummary) => void;
  canFilter?: (group: ListGroupSummary) => boolean;
  hide?: (group: ListGroupSummary) => (() => void) | undefined;
  /**
   * A section's own header content: `aside` beside its label and count (a
   * record link the label cannot carry), `actions` at its trailing edge.
   */
  header?: (group: ListGroupSummary) => {
    aside?: ReactNode;
    actions?: ReactNode;
  };
}

export interface GroupSection<T> {
  key: string;
  label: string;
  /** The section's rows in the whole filtered set, loaded or not. */
  count: number;
  depth: number;
  collapsed: boolean;
  onToggle?: () => void;
  items: T[];
  /** Applies "Filter to this"; absent when the section has no filter value. */
  onFilter?: () => void;
  /** Hides the section, keeping the grouping; absent when it cannot. */
  onHide?: () => void;
  aside?: ReactNode;
  actions?: ReactNode;
}

/**
 * Explicit server memberships attach canonical rows to each leaf. Prefix
 * headers may count unloaded records; those counts never partition pages.
 * A tree's children follow their canonical parent into every occurrence.
 */
export function groupSections<T>(
  items: readonly T[],
  config: GroupConfig,
  identity: (item: T) => string,
  isNested: (item: T) => boolean = () => false,
): GroupSection<T>[] {
  const sections: GroupSection<T>[] = [];
  const records = new Map<string, T[]>();
  let parent: T[] | undefined;
  for (const item of items) {
    if (isNested(item) && parent) parent.push(item);
    else {
      parent = [item];
      records.set(identity(item), parent);
    }
  }
  const prefixes = new Set<string>();
  const occurrences = new Map<string, T[]>();
  for (const member of config.memberships) {
    const record = records.get(member.id);
    if (!record) continue;
    for (let depth = 1; depth <= member.path.length; depth++) {
      prefixes.add(JSON.stringify(member.path.slice(0, depth)));
    }
    const key = JSON.stringify(member.path);
    const group = occurrences.get(key) ?? [];
    group.push(...record);
    occurrences.set(key, group);
  }
  for (const group of config.groups) {
    if (!prefixes.has(group.key)) continue;
    if (
      group.path
        .slice(0, -1)
        .some((_, index) =>
          config.collapsed?.has(JSON.stringify(group.path.slice(0, index + 1))),
        )
    )
      continue;
    const section: GroupSection<T> = {
      key: group.key,
      label: group.label,
      count: group.count,
      depth: group.path.length - 1,
      collapsed: config.collapsed?.has(group.key) ?? false,
      onToggle: config.onToggle
        ? () => config.onToggle?.(group.key)
        : undefined,
      items: occurrences.get(group.key) ?? [],
      onFilter:
        config.onFilter &&
        (config.canFilter?.(group) ??
          (group.path.at(-1) !== FILTER_NONE ||
            config.choice.filter?.noValue === true))
          ? () => config.onFilter?.(group)
          : undefined,
      onHide: config.hide?.(group),
      ...config.header?.(group),
    };
    // Consume the whole section before hiding rows, including nested children:
    // collapse changes presentation, never the server's page membership.
    if (section.collapsed) section.items = [];
    sections.push(section);
  }
  return sections;
}

export type GroupedVirtualItem<TItem> =
  | { kind: "header"; section: GroupSection<TItem> }
  | { kind: "row"; item: TItem; groupKey: string };

export function useGroupedList<TItem>(
  data: TItem[],
  groupConfig: GroupConfig | undefined,
  identity: (item: TItem) => string,
  isNested?: (item: TItem) => boolean,
): GroupedVirtualItem<TItem>[] | null {
  return useMemo(() => {
    if (!groupConfig) return null;
    return groupSections(data, groupConfig, identity, isNested).flatMap(
      (section): GroupedVirtualItem<TItem>[] => [
        { kind: "header", section },
        ...section.items.map((item) => ({
          kind: "row" as const,
          item,
          groupKey: section.key,
        })),
      ],
    );
  }, [data, groupConfig, identity, isNested]);
}
