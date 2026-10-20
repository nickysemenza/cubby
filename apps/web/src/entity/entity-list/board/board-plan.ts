import type { EntityBoardListView } from "@cubby/schemas/entity-definitions/definition";
import { FILTER_NONE } from "@cubby/schemas/filter-sentinel-fields";

import type {
  EntityListResultByEntity,
  ListEntity,
} from "~/entity/generated/entity-lists.gen";

export type BoardFilters = EntityBoardListView["filters"];
type ListRow = EntityListResultByEntity[ListEntity]["items"][number];
type RowValues<Row> = Row extends object ? Row[keyof Row] : never;
/** Dynamic declared fields retain the generated row values, including dates and enrichments. */
export type BoardRow = { id: string } & Partial<
  Record<string, RowValues<ListRow>>
>;

type BoardPageSpec = Pick<
  EntityBoardListView,
  "pageSize" | "caps" | "sort" | "filters"
>;
/** Counts belong to group summaries; only this group's card page is capped. */
export function boardGroupPage(
  view: BoardPageSpec,
  filters: BoardFilters,
  groupBy: string,
  filterField: string,
  group: { key: string; count: number },
  pageIndex: number,
) {
  const cap = view.caps.find(
    (cap) => cap.field === groupBy && cap.value === group.key,
  );
  return {
    filters: { ...filters, ...view.filters, [filterField]: [group.key] },
    sort: cap?.orderBy
      ? [{ orderBy: cap.orderBy, direction: cap.direction ?? "desc" }]
      : view.sort,
    pagination: {
      pageIndex: cap ? 0 : pageIndex,
      pageSize: cap?.limit ?? view.pageSize,
    },
  };
}
/** Position anchors and the destination patch travel in one domain transaction. */
export function boardMoveRequest(
  rows: BoardRow[],
  id: string,
  before: string | undefined,
  groupBy: string,
  key: string,
) {
  const ordered = rows.filter((row) => row.id !== id);
  const found = before
    ? ordered.findIndex((row) => row.id === before)
    : ordered.length;
  const index = found < 0 ? ordered.length : found;
  const group = { [groupBy]: key === FILTER_NONE ? null : key };
  return {
    position: {
      id,
      before: ordered[index]?.id ?? null,
      after: ordered[index - 1]?.id ?? null,
      group,
    },
    move: { id, patch: group },
  };
}

/** Pointer drops keep the top/bottom-half placement used by card reordering. */
export function boardDropBefore(
  rows: BoardRow[],
  target: string,
  side: "top" | "bottom",
) {
  const index = rows.findIndex((row) => row.id === target);
  return rows[index + (side === "bottom" ? 1 : 0)]?.id;
}
