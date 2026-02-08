import type { Entity } from "@cubby/schemas/entity";
import { useNavigate, useRouter } from "@tanstack/react-router";
import type { Table as ITable, Row } from "@tanstack/react-table";
import { useWindowVirtualizer } from "@tanstack/react-virtual";
import { Bug } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef } from "react";
import { MobileCard } from "~/components/entity/mobile-card";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { EntityIcon } from "~/entities/entities";
import { useDebug } from "~/hooks/useDebug";
import type { InfiniteScrollControls } from "../hooks/useInfiniteTableList";
import { DebugDialog } from "./DebugDialog";
import { EntityEmptyState, hasActiveFilters } from "./entity-empty-states";
import { useMobileListModel } from "./useMobileListModel";

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

export function MobileCardView<TItem>({
  table,
  entity,
  renderMobileCard,
  infiniteScroll,
}: MobileCardViewProps<TItem>) {
  const { isDebugEnabled } = useDebug();
  const navigate = useNavigate();
  const router = useRouter();
  const mobileRows = useMobileListModel({ table, entity });

  // Ref for scrollMargin offset calculation
  const listRef = useRef<HTMLDivElement>(null);

  // Window virtualizer — scrolls against the window, not a container
  const virtualizer = useWindowVirtualizer({
    count: mobileRows.length,
    estimateSize: () => 56,
    overscan: 8,
    scrollMargin: listRef.current?.offsetTop ?? 0,
  });

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

  const virtualItems = virtualizer.getVirtualItems();

  return (
    <div className="block overflow-x-hidden lg:hidden">
      {mobileRows.length ? (
        <div ref={listRef}>
          <div
            style={{
              height: `${virtualizer.getTotalSize()}px`,
              width: "100%",
              position: "relative",
            }}
          >
            {virtualItems.map((vi) => {
              const model = mobileRows[vi.index];
              const row = model.row;

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
                  <div
                    key={row.id}
                    ref={virtualizer.measureElement}
                    data-index={vi.index}
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      width: "100%",
                      transform: `translateY(${vi.start - virtualizer.options.scrollMargin}px)`,
                    }}
                  >
                    {renderMobileCard(row, defaultContent)}
                  </div>
                );
              }

              // Default compact row with right-aligned values
              return (
                <div
                  key={row.id}
                  ref={virtualizer.measureElement}
                  data-index={vi.index}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${vi.start - virtualizer.options.scrollMargin}px)`,
                  }}
                >
                  <MobileCard
                    variant="row"
                    title={model.title}
                    subtitle={model.subtitle}
                    imageSlot={
                      model.imageSlot ??
                      (entity && (
                        <div className="flex h-11 w-11 items-center justify-center rounded bg-muted/50">
                          <EntityIcon
                            entity={entity}
                            colored
                            className="h-5 w-5"
                          />
                        </div>
                      ))
                    }
                    rightValues={model.rightValues}
                    selectable={
                      isSelectable
                        ? {
                            isSelected: row.getIsSelected(),
                            onSelectionChange: (checked) =>
                              row.toggleSelected(checked),
                          }
                        : undefined
                    }
                    actions={model.actionsContent}
                    entity={entity}
                    onClick={
                      model.detailsHref
                        ? () => {
                            navigate({ to: model.detailsHref });
                          }
                        : undefined
                    }
                    onTouchStart={
                      model.detailsHref
                        ? () => {
                            router.preloadRoute({ to: model.detailsHref });
                          }
                        : undefined
                    }
                  >
                    {debugContent}
                  </MobileCard>
                </div>
              );
            })}
          </div>

          {/* Infinite scroll sentinel — placed after virtualizer content */}
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
      ) : entity ? (
        <EntityEmptyState
          entity={entity}
          isFiltered={hasActiveFilters(table.getState().columnFilters)}
        />
      ) : (
        <EntityEmptyState entity="product" isFiltered={true} />
      )}
    </div>
  );
}
