import { useState } from "react";
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
 *
 * @example Fixed entity (entity list pages)
 * ```tsx
 * const { onRowClick, PreviewSheet } = useEntityPreview("product");
 *
 * return (
 *   <div>
 *     <RTable table={table} onRowClick={onRowClick} ... />
 *     <PreviewSheet />
 *   </div>
 * );
 * ```
 *
 * @example Dynamic entity (search - entity varies per row)
 * ```tsx
 * const { onRowClick, PreviewSheet } = useEntityPreview();
 *
 * // Row must have entityType field
 * <RTable table={table} onRowClick={onRowClick} ... />
 * ```
 *
 * @example Custom ID field (e.g., USDA uses fdc_id)
 * ```tsx
 * const { onRowClick, PreviewSheet } = useEntityPreview("usda-food", { idField: "fdc_id" });
 * ```
 */
export function useEntityPreview(
  fixedEntity?: Entity,
  options?: UseEntityPreviewOptions,
) {
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const idField = options?.idField ?? "id";

  const onRowClick = (row: {
    original: Record<string, unknown> & { entityType?: Entity };
  }) => {
    const entityType = fixedEntity ?? row.original.entityType;
    if (!entityType) {
      console.warn("useEntityPreview: No entity type provided");
      return;
    }
    const id = row.original[idField];
    if (id === undefined || id === null) {
      console.warn(`useEntityPreview: No ${idField} field in row`);
      return;
    }
    setPreview({ entityType, id: String(id) });
  };

  const closePreview = () => setPreview(null);

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
