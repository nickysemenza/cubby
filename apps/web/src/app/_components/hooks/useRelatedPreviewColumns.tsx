import type { Entity } from "@cubby/schemas/entity";
import type {
  RelatedPreviewGroup,
  RelatedViewDefinition,
  RelatedViewKey,
} from "@cubby/schemas/related-view";
import { useQuery } from "@tanstack/react-query";
import type { ColumnDef, ColumnHelper } from "@tanstack/react-table";
import { useMemo, useRef } from "react";
import type { FilterableComboboxItem } from "~/components/ui/combobox";
import { manifestFilterConfig } from "~/entities/filter-manifest";
import { getSortableFields } from "~/entities/sortable-fields";
import { useTRPC } from "~/integrations/trpc/react";
import { RelatedPreviewCell } from "../data-table/related-preview-cell";

interface RelatedPreviewState {
  byCell: Map<string, RelatedPreviewGroup>;
  loading: boolean;
}

/**
 * Supplies stable relation-preview column definitions plus an explicit render
 * invalidation token. Cells intentionally read a ref so their definitions do
 * not churn as query data arrives; `rowContentVersion` is therefore required
 * to repaint memoized desktop rows and pre-rendered mobile cards.
 */
export function useRelatedPreviewColumns<TData extends { id: string }>({
  entity,
  sourceIds,
  visibleRelationKeys,
  relatedViews,
  columnHelper,
  filterOptions,
  supportsServerSorting,
}: {
  entity: Entity;
  sourceIds: string[];
  visibleRelationKeys: RelatedViewKey[];
  relatedViews: RelatedViewDefinition[];
  columnHelper: ColumnHelper<TData>;
  filterOptions?: Record<string, FilterableComboboxItem[]>;
  supportsServerSorting: boolean;
}): {
  // biome-ignore lint/suspicious/noExplicitAny: relation display columns are heterogeneous by design.
  relatedColumns: ColumnDef<TData, any>[];
  rowContentVersion: unknown;
} {
  const api = useTRPC();
  const relatedQuery = useQuery({
    ...api.relatedData.previews.queryOptions({
      source: entity,
      sourceIds,
      relationKeys: visibleRelationKeys,
    }),
    enabled: sourceIds.length > 0 && visibleRelationKeys.length > 0,
  });
  const relatedByCell = useMemo(() => {
    const map = new Map<string, RelatedPreviewGroup>();
    for (const group of relatedQuery.data ?? []) {
      map.set(`${group.sourceId}:${group.relationKey}`, group);
    }
    return map;
  }, [relatedQuery.data]);
  const relatedStateRef = useRef<RelatedPreviewState>({
    byCell: relatedByCell,
    loading: relatedQuery.isLoading,
  });
  relatedStateRef.current = {
    byCell: relatedByCell,
    loading: relatedQuery.isLoading,
  };

  const relatedColumns = useMemo(
    () =>
      relatedViews.map((view) => {
        const columnId = `related:${view.key}`;
        const filterConfig = supportsServerSorting
          ? manifestFilterConfig(entity, columnId, filterOptions)
          : undefined;
        return columnHelper.display({
          id: columnId,
          header: view.label,
          enableSorting:
            supportsServerSorting &&
            getSortableFields(entity).includes(columnId),
          meta: {
            className: "w-64",
            mobile: { slot: "meta", priority: 80 },
            ...(filterConfig ? { filterConfig } : {}),
          },
          cell: (info) => (
            <RelatedPreviewCell
              group={relatedStateRef.current.byCell.get(
                `${info.row.original.id}:${view.key}`,
              )}
              loading={relatedStateRef.current.loading}
            />
          ),
        });
      }),
    [columnHelper, entity, filterOptions, relatedViews, supportsServerSorting],
  );

  // The map and loading boolean each change only when a cell can render a
  // different preview. This object is passed through table meta to all row
  // render surfaces; do not replace it with the ref itself.
  const rowContentVersion = useMemo(
    () => ({ byCell: relatedByCell, loading: relatedQuery.isLoading }),
    [relatedByCell, relatedQuery.isLoading],
  );

  return { relatedColumns, rowContentVersion };
}
