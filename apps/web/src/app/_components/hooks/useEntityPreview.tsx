import type { Entity } from "@cubby/schemas/entity";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { PanelRight } from "lucide-react";
import type { ReactNode } from "react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { Button } from "~/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "~/components/ui/sheet";
import {
  entities,
  entityLabel,
  isBrowserRoutedEntity,
} from "~/entities/entities";
import { entityPreviewQueryOptions } from "~/entities/entity-query";

import { EntityWorkbenchInspector } from "../entity-workbench-inspector";

export interface PreviewState {
  entityType: Entity;
  id: string;
  rowKey: string;
}

export interface EntityPreviewRendererProps {
  preview: PreviewState;
  onClose: () => void;
}

type EntityPreviewRenderer = (props: EntityPreviewRendererProps) => ReactNode;

interface PreviewIntent {
  preview: PreviewState;
  queryKey: readonly unknown[];
  timer: ReturnType<typeof setTimeout> | null;
  started: boolean;
}

const PREVIEW_INTENT_DELAY_MS = 200;
const DOCK_MEDIA_QUERY = "(min-width: 1280px)";
const SHEET_MEDIA_QUERY = "(min-width: 768px) and (max-width: 1279px)";

export type PreviewPresentation = "dock" | "sheet" | "mobile";

const previewPresentation = (): PreviewPresentation => {
  if (typeof window === "undefined") return "mobile";
  if (window.matchMedia(DOCK_MEDIA_QUERY).matches) return "dock";
  if (window.matchMedia(SHEET_MEDIA_QUERY).matches) return "sheet";
  return "mobile";
};

const subscribePreviewPresentation = (onStoreChange: () => void) => {
  if (typeof window === "undefined") return () => undefined;
  const dock = window.matchMedia(DOCK_MEDIA_QUERY);
  const sheet = window.matchMedia(SHEET_MEDIA_QUERY);
  dock.addEventListener("change", onStoreChange);
  sheet.addEventListener("change", onStoreChange);
  return () => {
    dock.removeEventListener("change", onStoreChange);
    sheet.removeEventListener("change", onStoreChange);
  };
};

const getServerPreviewPresentation = (): PreviewPresentation => "mobile";

interface UseEntityPreviewOptions {
  /** Field to use as ID (default: "id") */
  idField?: string;
  /**
   * Opt into the workbench presentation: dock at desktop, Sheet at tablet,
   * and canonical navigation-only cards at mobile widths.
   *
   * Legacy callers that only render PreviewSheet stay Sheet-only at every
   * viewport so selecting a row never becomes invisible.
   */
  responsiveInspector?: boolean;
  /**
   * Product owns a denser, relationship-aware inspector. The responsive
   * presentation still belongs here so it follows the same selection and
   * close/reopen behavior as every other top-level list.
   */
  renderInspector?: EntityPreviewRenderer;
}

// Module-level so its identity never changes across renders — a component
// defined inside the hook body would get a fresh identity on every host
// re-render, forcing React to unmount/remount the Sheet subtree (killing the
// open/close animation and resetting scroll) even when preview hasn't changed.
function PreviewSheetView({
  preview,
  inspector,
  onClose,
}: {
  preview: PreviewState | null;
  inspector: ReactNode;
  onClose: () => void;
}) {
  return (
    <Sheet open={!!preview} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="right"
        showCloseButton={false}
        className="!w-[25rem] !max-w-[calc(100vw-2rem)] overflow-y-auto p-0"
      >
        {preview && (
          <>
            <SheetTitle className="sr-only">
              {entityLabel(preview.entityType)} {preview.id} preview
            </SheetTitle>
            {inspector}
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

function renderDefaultInspector({
  preview,
  onClose,
}: EntityPreviewRendererProps) {
  return (
    <EntityWorkbenchInspector
      entity={preview.entityType}
      id={preview.id}
      onClose={onClose}
    />
  );
}

export function useEntityPreview(
  fixedEntity?: Entity,
  options?: UseEntityPreviewOptions,
) {
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [isInspectorOpen, setInspectorOpen] = useState(false);
  const presentation = useSyncExternalStore(
    subscribePreviewPresentation,
    previewPresentation,
    getServerPreviewPresentation,
  );
  const idField = options?.idField ?? "id";
  const responsiveInspector = options?.responsiveInspector ?? false;
  const renderInspector = options?.renderInspector ?? renderDefaultInspector;
  const queryClient = useQueryClient();
  const navigate = useNavigate() as unknown as (options: {
    to: string;
    params: Record<string, string>;
  }) => Promise<void>;
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
      id?: string;
      original: T;
    }): PreviewState | null => {
      const rowData = row.original as T & {
        entityType?: Entity | string | null;
      };
      const entityType =
        fixedEntity ?? (rowData.entityType as Entity | undefined);
      if (!entityType) return null;
      const targetId = rowData[idField];
      if (targetId === undefined || targetId === null) return null;
      const id = String(targetId);
      const rowKey = String(row.id ?? rowData.id ?? id);
      return { entityType, id, rowKey };
    },
    [fixedEntity, idField],
  );

  // Accept a TanStack Row<T> or a lightweight row with an 'original' property.
  // The row key controls list selection; idField independently identifies the
  // canonical entity target for heterogeneous relationship rosters.
  const onRowClick = useCallback(
    <T extends Record<string, unknown>>(row: { id?: string; original: T }) => {
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
      setInspectorOpen(true);
    },
    [resolveRow, stopIntent],
  );

  /**
   * Inspect an explicitly selected record.
   *
   * Desktop and tablet reuse the exact same current-record state as a row
   * click. Phones continue to use the complete canonical detail route — the
   * selection bar must not introduce a squeezed or second mobile inspector.
   */
  const inspectRow = useCallback(
    <T extends Record<string, unknown>>(row: { id?: string; original: T }) => {
      const resolved = resolveRow(row);
      if (!resolved || !isBrowserRoutedEntity(resolved.entityType)) return;

      if (responsiveInspector && presentation === "mobile") {
        const params: Record<string, string> =
          resolved.entityType === "usda-food"
            ? { id: resolved.id }
            : { shortcode: resolved.id };
        void navigate({
          to: entities[resolved.entityType].routes.detail,
          params,
        });
        return;
      }

      setPreview(resolved);
      setInspectorOpen(true);
    },
    [navigate, presentation, resolveRow, responsiveInspector],
  );

  const onRowHover = useCallback(
    <T extends Record<string, unknown>>(row: { id?: string; original: T }) => {
      const resolved = resolveRow(row);
      if (!resolved || !isBrowserRoutedEntity(resolved.entityType)) {
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

      const queryOptions = entityPreviewQueryOptions(
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
          // oxlint-disable-next-line typescript/no-explicit-any -- the generated entity union cannot be narrowed at this dispatch seam
          ...(queryOptions as any),
          meta: { ...queryOptions.meta, speculative: true },
        });
      }, PREVIEW_INTENT_DELAY_MS);
      intentRef.current = intent;
    },
    [resolveRow, queryClient, stopIntent],
  );

  const onRowHoverEnd = useCallback(
    <T extends Record<string, unknown>>(row: { id?: string; original: T }) => {
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

  // Closing the presentation must not discard the selected record: the row
  // remains current and the table toolbar can reopen it without another click.
  const closePreview = useCallback(() => setInspectorOpen(false), []);
  const toggleInspector = useCallback(
    () => setInspectorOpen((open) => !open),
    [],
  );

  const inspector = useMemo(
    () =>
      preview ? renderInspector({ preview, onClose: closePreview }) : null,
    [preview, renderInspector, closePreview],
  );

  // Stable identity as long as preview/closePreview haven't changed, so a
  // host re-render for unrelated reasons (e.g. list background refetch)
  // doesn't remount the sheet — only an actual preview state change does.
  const PreviewSheet = useCallback(
    () => (
      <PreviewSheetView
        preview={
          (!responsiveInspector || presentation === "sheet") && isInspectorOpen
            ? preview
            : null
        }
        inspector={inspector}
        onClose={closePreview}
      />
    ),
    [
      responsiveInspector,
      presentation,
      isInspectorOpen,
      preview,
      inspector,
      closePreview,
    ],
  );

  const dockedInspector =
    responsiveInspector && presentation === "dock" && isInspectorOpen
      ? inspector
      : null;

  const inspectorToggle = useMemo(
    () =>
      responsiveInspector && presentation !== "mobile" ? (
        <Button
          variant="ghost"
          size="icon-lg"
          className="shrink-0"
          disabled={!preview}
          onClick={toggleInspector}
          aria-label={isInspectorOpen ? "Close inspector" : "Open inspector"}
          aria-pressed={isInspectorOpen}
        >
          <PanelRight className="size-4" />
        </Button>
      ) : null,
    [
      responsiveInspector,
      presentation,
      preview,
      isInspectorOpen,
      toggleInspector,
    ],
  );

  return {
    onRowClick,
    inspectRow,
    onRowHover,
    onRowHoverEnd,
    PreviewSheet,
    dockedInspector,
    inspectorToggle,
    preview,
    setPreview,
    closePreview,
    isInspectorOpen,
    presentation,
  };
}
