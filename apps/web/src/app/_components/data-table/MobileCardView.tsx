import type { Entity } from "@cubby/schemas/entity";
import { useNavigate } from "@tanstack/react-router";
import {
  flexRender,
  type Table as ITable,
  type Row,
} from "@tanstack/react-table";
import { Bug } from "lucide-react";
import {
  isValidElement,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
} from "react";
import { MobileCard } from "~/components/entity/mobile-card";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { entities } from "~/entities/entities";
import { useDebug } from "~/hooks/useDebug";
import { extractEntityTitle } from "~/lib/entity-utils";
import type { InfiniteScrollControls } from "../hooks/useInfiniteTableList";
import { NoneState } from "../NoneState";
import { DebugDialog } from "./DebugDialog";
import { EntityEmptyState, hasActiveFilters } from "./entity-empty-states";

interface MobileCardViewProps<TItem> {
  table: ITable<TItem>;
  /** Entity type for navigation - when provided, cards show a view button */
  entity?: Entity;
  /**
   * Custom render function for mobile cards.
   * Receives the row and the default card content, allowing full customization.
   * Useful for tables with inline editing or special mobile UX.
   */
  renderMobileCard?: (row: Row<TItem>, defaultContent: ReactNode) => ReactNode;
  /** Infinite scroll controls — when provided, auto-loads more at bottom */
  infiniteScroll?: InfiniteScrollControls;
}

/** Column IDs automatically hidden on mobile — verbose or complex fields */
const MOBILE_HIDDEN_COLUMNS = new Set([
  "createdAt",
  "notes",
  "ndb_number",
  "model",
  "fdc_id",
  "unitMapping",
  "unitMappings",
  "inventoryEntry",
  "inventoryEntries",
  "food",
  "nutrition",
  "meta",
]);

/**
 * Check if a rendered cell has meaningful content worth displaying.
 * Filters out null, empty strings, "—", and NoneState elements.
 */
function hasContent(content: ReactNode): boolean {
  if (content === null || content === undefined) return false;
  if (typeof content === "string") {
    const trimmed = content.trim();
    return trimmed !== "" && trimmed !== "—";
  }
  if (isValidElement(content) && content.type === NoneState) return false;
  return true;
}

export function MobileCardView<TItem>({
  table,
  entity,
  renderMobileCard,
  infiniteScroll,
}: MobileCardViewProps<TItem>) {
  const { isDebugEnabled } = useDebug();
  const navigate = useNavigate();

  // Infinite scroll sentinel — IntersectionObserver triggers fetchNextPage
  const sentinelRef = useRef<HTMLDivElement>(null);
  const fetchNextPage = infiniteScroll?.fetchNextPage;
  const hasNextPage = infiniteScroll?.hasNextPage ?? false;
  const isFetchingNextPage = infiniteScroll?.isFetchingNextPage ?? false;

  const handleIntersect = useCallback(
    (entries: IntersectionObserverEntry[]) => {
      if (entries[0]?.isIntersecting && hasNextPage && !isFetchingNextPage) {
        fetchNextPage?.();
      }
    },
    [fetchNextPage, hasNextPage, isFetchingNextPage],
  );

  useEffect(() => {
    if (!infiniteScroll) return;
    const sentinel = sentinelRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(handleIntersect, {
      rootMargin: "200px",
    });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [infiniteScroll, handleIntersect]);

  // Check if table has row selection enabled
  const hasRowSelection = table.options.enableRowSelection !== false;
  const hasSelectColumn = table
    .getAllColumns()
    .some((col) => col.id === "select");
  const isSelectable = hasRowSelection && hasSelectColumn;

  // Get the base path for navigation from entity config
  const basePath = entity ? entities[entity].basePath : undefined;

  return (
    <div className="block space-y-0 lg:hidden">
      {table.getRowModel().rows?.length ? (
        table.getRowModel().rows.map((row) => {
          // Extract actions cell content (for MobileCard.actions slot)
          const actionsCell = row
            .getVisibleCells()
            .find((cell) => cell.column.id === "actions");
          const actionsContent = actionsCell
            ? flexRender(
                actionsCell.column.columnDef.cell,
                actionsCell.getContext(),
              )
            : undefined;

          // Get title using generic utility function
          const titleString = extractEntityTitle(row.original);

          // Extract raw data
          const rowData = row.original as Record<string, unknown>;

          // Render the image column content if present
          const imageCell = row
            .getVisibleCells()
            .find((cell) => cell.column.id === "image");
          const imageContent = imageCell
            ? flexRender(
                imageCell.column.columnDef.cell,
                imageCell.getContext(),
              )
            : undefined;

          // Collect visible non-hero, non-hidden field values for right side
          const rightValues: ReactNode[] = [];
          let subtitleText: string | undefined;

          for (const cell of row.getVisibleCells()) {
            const colId = cell.column.id;

            // Skip utility columns and hero fields
            if (
              colId === "select" ||
              colId === "actions" ||
              colId === "image" ||
              colId === "name"
            )
              continue;

            // Skip hidden columns (auto-hide list + per-column opt-out)
            if (
              MOBILE_HIDDEN_COLUMNS.has(colId) ||
              cell.column.columnDef.meta?.mobileHidden
            )
              continue;

            // Quick-reject: skip cells with empty raw accessor values
            // (catches nulls wrapped in EditableCell that hasContent can't see through)
            const rawValue = cell.getValue();
            if (
              rawValue === null ||
              rawValue === undefined ||
              rawValue === "" ||
              (Array.isArray(rawValue) && rawValue.length === 0)
            )
              continue;

            const content = flexRender(
              cell.column.columnDef.cell,
              cell.getContext(),
            );

            if (!hasContent(content)) continue;

            // Use first badge/category-like field as subtitle
            const category = cell.column.columnDef.meta?.mobileCategory;
            if (
              !subtitleText &&
              (category === "medium" || category === "compact") &&
              typeof content === "string"
            ) {
              subtitleText = content;
              continue;
            }

            // Collect up to 2 right-aligned values
            if (rightValues.length < 2) {
              rightValues.push(content);
            }
          }

          // Pass raw image content — MobileCard row variant handles sizing
          const imageSlot = imageContent || undefined;

          // Build details href for navigation
          const entityId = rowData.id as string | undefined;
          const detailsHref =
            basePath && entityId ? `/${basePath}/${entityId}` : undefined;

          // Debug footer (only in row children if debug mode)
          const debugContent = isDebugEnabled ? (
            <div className="flex items-center gap-1">
              <DebugDialog
                data={row.original}
                title={`Debug Data - Row ${row.id}`}
                trigger={
                  <Button variant="ghost" size="sm" className="h-6 w-6 p-0">
                    <Bug className="h-3 w-3" />
                    <span className="sr-only">Debug row data</span>
                  </Button>
                }
              />
            </div>
          ) : undefined;

          // Default content (just debug if enabled, otherwise nothing)
          const defaultContent = debugContent ?? null;

          // Allow custom rendering for special cases (e.g., inline editing)
          if (renderMobileCard) {
            return (
              <div key={row.id}>{renderMobileCard(row, defaultContent)}</div>
            );
          }

          // Default compact row with right-aligned values
          return (
            <MobileCard
              key={row.id}
              variant="row"
              title={titleString}
              subtitle={subtitleText}
              imageSlot={imageSlot}
              rightValues={rightValues}
              selectable={
                isSelectable
                  ? {
                      isSelected: row.getIsSelected(),
                      onSelectionChange: (checked) =>
                        row.toggleSelected(checked),
                    }
                  : undefined
              }
              actions={actionsContent}
              entity={entity}
              onClick={
                detailsHref
                  ? () => {
                      navigate({ to: detailsHref });
                    }
                  : undefined
              }
            >
              {debugContent}
            </MobileCard>
          );
        })
      ) : entity ? (
        <EntityEmptyState
          entity={entity}
          isFiltered={hasActiveFilters(table.getState().columnFilters)}
        />
      ) : (
        <EntityEmptyState entity="product" isFiltered={true} />
      )}

      {/* Infinite scroll sentinel and loading indicator */}
      {infiniteScroll && (
        <>
          <div ref={sentinelRef} className="h-1" />
          {isFetchingNextPage && (
            <div className="flex items-center justify-center py-4">
              <Spinner size="sm" className="text-muted-foreground" />
            </div>
          )}
        </>
      )}
    </div>
  );
}
