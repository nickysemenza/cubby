import type { Entity } from "@cubby/schemas/entity";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { Sheet, SheetContent } from "~/components/ui/sheet";
import { isBrowserRoutedEntity } from "~/entities/entities";
import { getEntityContract } from "~/entities/entity-contracts";
import { entityQueryOptions } from "~/entities/entity-query";
import { useTRPC } from "~/integrations/trpc/react";
import { EntityPreviewPanel } from "../search/entity-preview-panel";

interface PreviewState {
  entityType: Entity;
  id: string;
}

interface PreviewIntent {
  preview: PreviewState;
  queryKey: readonly unknown[];
  timer: ReturnType<typeof setTimeout> | null;
  started: boolean;
}

const PREVIEW_INTENT_DELAY_MS = 200;

interface UseEntityPreviewOptions {
  /** Field to use as ID (default: "id") */
  idField?: string;
}

// Module-level so its identity never changes across renders — a component
// defined inside the hook body would get a fresh identity on every host
// re-render, forcing React to unmount/remount the Sheet subtree (killing the
// open/close animation and resetting scroll) even when preview hasn't changed.
function PreviewSheetView({
  preview,
  onClose,
}: {
  preview: PreviewState | null;
  onClose: () => void;
}) {
  return (
    <Sheet open={!!preview} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="!w-1/2 !max-w-none overflow-y-auto">
        {preview && (
          <EntityPreviewPanel entityType={preview.entityType} id={preview.id} />
        )}
      </SheetContent>
    </Sheet>
  );
}

export function useEntityPreview(
  fixedEntity?: Entity,
  options?: UseEntityPreviewOptions,
) {
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const idField = options?.idField ?? "id";
  const api = useTRPC();
  const queryClient = useQueryClient();
  const intentRef = useRef<PreviewIntent | null>(null);

  const stopIntent = useCallback(
    (intent: PreviewIntent, cancelStarted: boolean) => {
      if (intent.timer) clearTimeout(intent.timer);
      if (cancelStarted && intent.started) {
        void queryClient.cancelQueries({
          queryKey: intent.queryKey,
          exact: true,
          type: "inactive",
        });
      }
      if (intentRef.current === intent) intentRef.current = null;
    },
    [queryClient],
  );

  useEffect(
    () => () => {
      const intent = intentRef.current;
      if (intent) stopIntent(intent, true);
    },
    [stopIntent],
  );

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
      if (!isBrowserRoutedEntity(resolved.entityType)) return;
      const intent = intentRef.current;
      if (
        intent?.preview.entityType === resolved.entityType &&
        intent.preview.id === resolved.id
      ) {
        stopIntent(intent, false);
      }
      setPreview(resolved);
    },
    [resolveRow, stopIntent],
  );

  const onRowHover = useCallback(
    <T extends Record<string, unknown>>(row: { original: T }) => {
      const resolved = resolveRow(row);
      if (
        !resolved ||
        !isBrowserRoutedEntity(resolved.entityType) ||
        !getEntityContract(resolved.entityType).canPreview
      ) {
        return;
      }

      const previous = intentRef.current;
      if (
        previous?.preview.entityType === resolved.entityType &&
        previous.preview.id === resolved.id
      ) {
        return;
      }
      if (previous) stopIntent(previous, true);

      const queryOptions = entityQueryOptions(
        api,
        resolved.entityType,
        resolved.id,
      ) as {
        queryKey: readonly unknown[];
        meta?: Record<string, unknown>;
        [key: string]: unknown;
      };
      const intent: PreviewIntent = {
        preview: resolved,
        queryKey: queryOptions.queryKey,
        timer: null,
        started: false,
      };
      intent.timer = setTimeout(() => {
        intent.timer = null;
        intent.started = true;
        void queryClient.prefetchQuery({
          // biome-ignore lint/suspicious/noExplicitAny: the generated entity union cannot be narrowed at this dispatch seam
          ...(queryOptions as any),
          meta: { ...queryOptions.meta, speculativePreview: true },
        });
      }, PREVIEW_INTENT_DELAY_MS);
      intentRef.current = intent;
    },
    [resolveRow, api, queryClient, stopIntent],
  );

  const onRowHoverEnd = useCallback(
    <T extends Record<string, unknown>>(row: { original: T }) => {
      const resolved = resolveRow(row);
      const intent = intentRef.current;
      if (
        !resolved ||
        !intent ||
        intent.preview.entityType !== resolved.entityType ||
        intent.preview.id !== resolved.id
      ) {
        return;
      }
      stopIntent(intent, true);
    },
    [resolveRow, stopIntent],
  );

  const closePreview = useCallback(() => setPreview(null), []);

  // Stable identity as long as preview/closePreview haven't changed, so a
  // host re-render for unrelated reasons (e.g. list background refetch)
  // doesn't remount the sheet — only an actual preview state change does.
  const PreviewSheet = useCallback(
    () => <PreviewSheetView preview={preview} onClose={closePreview} />,
    [preview, closePreview],
  );

  return {
    onRowClick,
    onRowHover,
    onRowHoverEnd,
    PreviewSheet,
    preview,
    setPreview,
    closePreview,
  };
}
