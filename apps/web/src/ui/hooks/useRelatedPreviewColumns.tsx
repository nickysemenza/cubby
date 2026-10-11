import type { BrowserRoutedEntity } from "@cubby/schemas/entity-manifest";
import type {
  RelatedPreviewGroup,
  RelatedViewDefinition,
  RelatedViewKey,
} from "@cubby/schemas/related-view";
import { type UseQueryResult, useQueries } from "@tanstack/react-query";
import { type RefObject, useMemo, useRef } from "react";

import { getSortableFields } from "~/entity/entities";
import { manifestFilterConfig } from "~/entity/filter-manifest";
import { relatedData } from "~/integrations/tanstack-query/generated/catalog.gen";

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
  loadingSourceIds: Set<string>;
  errorsBySourceId: Map<string, Error>;
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

// Keep descriptor inputs within relatedPreviewInput's sourceIds contract.
const RELATED_PREVIEW_SOURCE_ID_LIMIT = 1000;

const productionRelatedPreviewOperations: RelatedPreviewOperations = {
  previews: relatedData.previews,
};

export function useRelatedPreviewStateRef() {
  return useRef<RelatedPreviewState>({
    byCell: new Map(),
    loading: false,
    loadingSourceIds: new Set(),
    errorsBySourceId: new Map(),
  });
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
          cell: (info) => {
            const state = relatedStateRef.current;
            const sourceId = info.row.original.id;
            return (
              <RelatedPreviewCell
                group={state?.byCell.get(`${sourceId}:${view.key}`)}
                loading={state?.loadingSourceIds.has(sourceId) ?? false}
                error={state?.errorsBySourceId.get(sourceId)}
              />
            );
          },
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
  const relatedQueryInputs = useMemo(() => {
    if (sourceIds.length === 0 || visibleRelationKeys.length === 0) {
      return { queries: [], sourceIdChunks: [] };
    }

    const queries: ReturnType<typeof operations.previews.queryOptions>[] = [];
    const sourceIdChunks: string[][] = [];
    for (
      let start = 0;
      start < sourceIds.length;
      start += RELATED_PREVIEW_SOURCE_ID_LIMIT
    ) {
      const chunkIds = sourceIds.slice(
        start,
        start + RELATED_PREVIEW_SOURCE_ID_LIMIT,
      );
      sourceIdChunks.push(chunkIds);
      queries.push(
        operations.previews.queryOptions({
          source: entity,
          sourceIds: chunkIds,
          relationKeys: visibleRelationKeys,
        }),
      );
    }
    return { queries, sourceIdChunks };
  }, [entity, operations, sourceIds, visibleRelationKeys]);
  const combineRelatedQueries = useMemo(
    () =>
      (
        results: readonly UseQueryResult<RelatedPreviewGroup[], Error>[],
      ): RelatedPreviewState => {
        const byCell = new Map<string, RelatedPreviewGroup>();
        const loadingSourceIds = new Set<string>();
        const errorsBySourceId = new Map<string, Error>();
        results.forEach((result, index) => {
          const chunkIds = relatedQueryInputs.sourceIdChunks[index] ?? [];
          if (result.isLoading) {
            for (const sourceId of chunkIds) loadingSourceIds.add(sourceId);
          }
          if (result.error) {
            for (const sourceId of chunkIds)
              errorsBySourceId.set(sourceId, result.error);
          }
          for (const group of result.data ?? []) {
            byCell.set(`${group.sourceId}:${group.relationKey}`, group);
          }
        });
        return {
          byCell,
          loading: loadingSourceIds.size > 0,
          loadingSourceIds,
          errorsBySourceId,
        };
      },
    [relatedQueryInputs.sourceIdChunks],
  );
  const relatedState = useQueries({
    queries: relatedQueryInputs.queries,
    combine: combineRelatedQueries,
  });
  relatedStateRef.current = relatedState;

  return useMemo(() => relatedState, [relatedState]);
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
