import type { Entity } from "@cubby/schemas/entity";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { Sheet, SheetContent } from "~/components/ui/sheet";
import { getEntityContract } from "~/entities/entity-contracts";
import { entityQueryOptions } from "~/entities/entity-query";
import { useTRPC } from "~/trpc/react";
import { EntityPreviewPanel } from "../search/entity-preview-panel";

interface PreviewState {
  entityType: Entity;
  id: string;
}

interface UseEntityPreviewOptions {
  /** Field to use as ID (default: "id") */
  idField?: string;
}

/**
 * Hook for adding row-click preview panels to entity lists. Hovering a row
 * prefetches the preview's `getByID` query so the click opens warm.
 */
export function useEntityPreview(
  fixedEntity?: Entity,
  options?: UseEntityPreviewOptions,
) {
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const idField = options?.idField ?? "id";
  const api = useTRPC();
  const queryClient = useQueryClient();

  // Resolve { entityType, id } from a row the same way for click + hover.
  // Note: entityType is handled separately to avoid conflicts with data that
  // has its own entityType field (search results carry a per-row entityType).
  const resolveRow = useCallback(
    <T extends Record<string, unknown>>(row: {
      original: T;
    }): PreviewState | null => {
      const rowData = row.original as T & {
        entityType?: Entity | string | null;
      };
      const entityType =
        fixedEntity ?? (rowData.entityType as Entity | undefined);
      if (!entityType) return null;
      const id = rowData[idField];
      if (id === undefined || id === null) return null;
      return { entityType, id: String(id) };
    },
    [fixedEntity, idField],
  );

  // Accept any row with an 'original' property that has at least an id field.
  // Compatible with TanStack's Row<T> for any T.
  const onRowClick = useCallback(
    <T extends Record<string, unknown>>(row: { original: T }) => {
      const resolved = resolveRow(row);
      if (!resolved) {
        console.warn("useEntityPreview: could not resolve entity/id from row");
        return;
      }
      setPreview(resolved);
    },
    [resolveRow],
  );

  // Prefetch the preview query on hover so the sheet opens without a spinner.
  // Same options the panel's useQuery uses → guaranteed cache hit. prefetchQuery
  // no-ops when the data is fresh or already in flight.
  const onRowHover = useCallback(
    <T extends Record<string, unknown>>(row: { original: T }) => {
      const resolved = resolveRow(row);
      if (!resolved || !getEntityContract(resolved.entityType).canPreview) {
        return;
      }
      void queryClient.prefetchQuery(
        // biome-ignore lint/suspicious/noExplicitAny: union of getByID queryOptions can't be narrowed for prefetchQuery (same cast the panel uses for useQuery)
        entityQueryOptions(api, resolved.entityType, resolved.id) as any,
      );
    },
    [resolveRow, api, queryClient],
  );

  const closePreview = useCallback(() => setPreview(null), []);

  const PreviewSheet = () => (
    <Sheet open={!!preview} onOpenChange={(open) => !open && closePreview()}>
      <SheetContent side="right" className="!w-1/2 !max-w-none overflow-y-auto">
        {preview && (
          <EntityPreviewPanel entityType={preview.entityType} id={preview.id} />
        )}
      </SheetContent>
    </Sheet>
  );

  return {
    onRowClick,
    onRowHover,
    PreviewSheet,
    preview,
    setPreview,
    closePreview,
  };
}
