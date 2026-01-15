import { useCallback, useState } from "react";
import { Sheet, SheetContent } from "~/components/ui/sheet";
import type { Entity } from "~/entities/types";
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
 * Hook for adding row-click preview panels to entity lists.
 */
export function useEntityPreview(
  fixedEntity?: Entity,
  options?: UseEntityPreviewOptions,
) {
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const idField = options?.idField ?? "id";

  // Accept any row with an 'original' property that has at least an id field
  // This is compatible with TanStack's Row<T> for any T
  // Note: entityType is handled separately to avoid conflicts with data that has its own entityType field
  const onRowClick = useCallback(
    <T extends Record<string, unknown>>(row: { original: T }) => {
      // Cast to access entityType which may be present on some rows (like search results)
      const rowData = row.original as T & {
        entityType?: Entity | string | null;
      };
      const entityType =
        fixedEntity ?? (rowData.entityType as Entity | undefined);
      if (!entityType) {
        console.warn("useEntityPreview: No entity type provided");
        return;
      }
      const id = rowData[idField];
      if (id === undefined || id === null) {
        console.warn(`useEntityPreview: No ${idField} field in row`);
        return;
      }
      setPreview({ entityType, id: String(id) });
    },
    [fixedEntity, idField],
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

  return { onRowClick, PreviewSheet, preview, setPreview, closePreview };
}
