import type { BrowserRoutedEntity } from "@cubby/schemas/entity-manifest";
import type {
  RelatedPreviewGroup,
  RelatedViewDefinition,
  RelatedViewKey,
} from "@cubby/schemas/related-view";
import { useQuery } from "@tanstack/react-query";
import { type RefObject, useMemo, useRef } from "react";

import { getSortableFields } from "~/entities/entities";
import { manifestFilterConfig } from "~/entities/filter-manifest";
import { relatedData } from "~/lib/related-data.functions";

import { RelatedPreviewCell } from "../data-table/related-preview-cell";
import type {
  CubbyColumnDef as ColumnDef,
  CubbyColumnHelper as ColumnHelper,
} from "../data-table/table-features";
import type { FilterConfig, MobileColumnMeta } from "../data-table/table-meta";
import type { RuntimeFilterOptions } from "./filter-option-types";

export interface RelatedPreviewState {
  byCell: Map<string, RelatedPreviewGroup>;
  loading: boolean;
}

export interface RelatedPreviewColumnsResult<TData extends { id: string }> {
  relatedColumns: ColumnDef<TData>[];
  rowContentVersion: RelatedPreviewState;
}

interface RelatedPreviewColumnMeta {
  filterConfig?: FilterConfig;
  mobile: MobileColumnMeta;
}

export interface RelatedPreviewOperations {
  previews: typeof relatedData.previews;
}

const productionRelatedPreviewOperations: RelatedPreviewOperations = {
  previews: relatedData.previews,
};

export function useRelatedPreviewStateRef() {
  return useRef<RelatedPreviewState>({ byCell: new Map(), loading: false });
}

export function useRelatedPreviewColumnDefs<TData extends { id: string }>({
  entity,
  relatedViews,
  columnHelper,
  filterOptions,
  supportsServerSorting,
  relatedStateRef,
}: {
  entity: BrowserRoutedEntity;
  relatedViews: readonly RelatedViewDefinition[];
  columnHelper: ColumnHelper<TData>;
  filterOptions?: RuntimeFilterOptions;
  supportsServerSorting: boolean;
  relatedStateRef: RefObject<RelatedPreviewState>;
}): ColumnDef<TData>[] {
  return useMemo(
    () =>
      relatedViews.map((view) => {
        const columnId = `related:${view.key}`;
        const filterConfig = supportsServerSorting
          ? manifestFilterConfig(entity, columnId, filterOptions)
          : undefined;
        const meta: RelatedPreviewColumnMeta = {
          mobile: { slot: "meta", priority: 80 },
        };
        if (filterConfig) meta.filterConfig = filterConfig;
        return columnHelper.display({
          id: columnId,
          header: view.label,
          size: 256,
          enableSorting:
            supportsServerSorting &&
            getSortableFields(entity).includes(columnId),
          meta,
          cell: (info) => (
            <RelatedPreviewCell
              group={relatedStateRef.current?.byCell.get(
                `${info.row.original.id}:${view.key}`,
              )}
              loading={relatedStateRef.current?.loading ?? false}
            />
          ),
        });
      }),
    [
      columnHelper,
      entity,
      filterOptions,
      relatedStateRef,
      relatedViews,
      supportsServerSorting,
    ],
  );
}

export function useRelatedPreviewData({
  entity,
  sourceIds,
  visibleRelationKeys,
  relatedStateRef,
  operations = productionRelatedPreviewOperations,
}: {
  entity: BrowserRoutedEntity;
  sourceIds: string[];
  visibleRelationKeys: RelatedViewKey[];
  relatedStateRef: RefObject<RelatedPreviewState>;
  operations?: RelatedPreviewOperations;
}): RelatedPreviewState {
  const relatedQuery = useQuery({
    ...operations.previews.queryOptions({
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
  relatedStateRef.current = {
    byCell: relatedByCell,
    loading: relatedQuery.isLoading,
  };

  return useMemo(
    () => ({ byCell: relatedByCell, loading: relatedQuery.isLoading }),
    [relatedByCell, relatedQuery.isLoading],
  );
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
  operations,
}: {
  entity: BrowserRoutedEntity;
  sourceIds: string[];
  visibleRelationKeys: RelatedViewKey[];
  relatedViews: readonly RelatedViewDefinition[];
  columnHelper: ColumnHelper<TData>;
  filterOptions?: RuntimeFilterOptions;
  supportsServerSorting: boolean;
  operations?: RelatedPreviewOperations;
}): RelatedPreviewColumnsResult<TData> {
  const relatedStateRef = useRelatedPreviewStateRef();
  const relatedColumns = useRelatedPreviewColumnDefs({
    entity,
    relatedViews,
    columnHelper,
    filterOptions,
    supportsServerSorting,
    relatedStateRef,
  });
  const rowContentVersion = useRelatedPreviewData({
    entity,
    sourceIds,
    visibleRelationKeys,
    relatedStateRef,
    operations,
  });

  return { relatedColumns, rowContentVersion };
}
