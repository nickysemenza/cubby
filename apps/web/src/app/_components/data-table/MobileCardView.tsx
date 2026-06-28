import type { Entity } from "@cubby/schemas/entity";
import { useNavigate } from "@tanstack/react-router";
import type { Table as ITable, Row } from "@tanstack/react-table";
import { useWindowVirtualizer } from "@tanstack/react-virtual";
import { Bug } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef } from "react";
import { MobileCard } from "~/components/entity/mobile-card";
import { type SwipeAction, SwipeRow } from "~/components/entity/swipe-row";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { EntityIcon } from "~/entities/entities";
import { useDebug } from "~/hooks/useDebug";
import type { InfiniteScrollControls } from "../hooks/useInfiniteTableList";
import { DebugDialog } from "./DebugDialog";
import { EntityEmptyState, hasActiveFilters } from "./entity-empty-states";
import { SectionHeader } from "./SectionHeader";
import type { GroupConfig } from "./useGroupedList";
import { useGroupedList } from "./useGroupedList";
import { useMobileListModel } from "./useMobileListModel";

// Absolutely-positioned virtualizer row wrapper — virtualizer mechanics
// (measureElement ref + data-index + translateY), shared by all 3 render sites.
type WindowVirtualizer = ReturnType<typeof useWindowVirtualizer>;
type VirtualItem = ReturnType<WindowVirtualizer["getVirtualItems"]>[number];

function VirtualRow({
  vi,
  virtualizer,
  children,
}: {
  vi: VirtualItem;
  virtualizer: WindowVirtualizer;
  children: ReactNode;
}) {
  return (
    <div
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
      {children}
    </div>
  );
}

interface MobileCardViewProps<TItem> {
  table: ITable<TItem>;
  /** Entity type for navigation - when provided, cards show a view button */
  entity?: Entity;
  /** Infinite scroll controls — when provided, auto-loads more at bottom */
  infiniteScroll?: InfiniteScrollControls;
  /** Group configuration for section headers */
  groupConfig?: GroupConfig<TItem>;
  /** Whether grouping is currently active */
  grouped?: boolean;
  /** Swipe-to-reveal actions per row (mobile lists, e.g. inventory move/delete) */
  swipeActions?: (row: Row<TItem>) => SwipeAction[];
}

export function MobileCardView<TItem>({
  table,
  entity,
  infiniteScroll,
  groupConfig,
  grouped = false,
  swipeActions,
}: MobileCardViewProps<TItem>) {
  const { isDebugEnabled } = useDebug();
  const navigate = useNavigate();
  const mobileRows = useMobileListModel({ table, entity });

  // Build a lookup from table row index to mobileRow model
  const rowIndexToModel = useMemo(() => {
    const map = new Map<number, (typeof mobileRows)[number]>();
    for (const model of mobileRows) {
      // row.index is the index within the table row model
      map.set(model.row.index, model);
    }
    return map;
  }, [mobileRows]);

  // Build grouped items when grouping is active
  const allData = useMemo(
    () => table.getRowModel().rows.map((r) => r.original),
    [table],
  );
  const groupedItems = useGroupedList(allData, groupConfig, grouped);

  // Determine virtualizer item count and estimate sizes
  const itemCount = groupedItems ? groupedItems.length : mobileRows.length;
  const estimateSize = useCallback(
    (index: number) => {
      if (groupedItems) {
        return groupedItems[index]?.kind === "header" ? 36 : 56;
      }
      return 56;
    },
    [groupedItems],
  );

  // Ref for scrollMargin offset calculation
  const listRef = useRef<HTMLDivElement>(null);

  // Window virtualizer — scrolls against the window, not a container
  const virtualizer = useWindowVirtualizer({
    count: itemCount,
    estimateSize,
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

  const renderVirtualItem = (vi: (typeof virtualItems)[number]) => {
    // --- Grouped mode ---
    if (groupedItems) {
      const gItem = groupedItems[vi.index];
      if (!gItem) return null;

      if (gItem.kind === "header") {
        return (
          <VirtualRow
            key={`header-${gItem.title}`}
            vi={vi}
            virtualizer={virtualizer}
          >
            <SectionHeader
              title={gItem.title}
              count={gItem.count}
              color={gItem.color}
            />
          </VirtualRow>
        );
      }

      // gItem.kind === "row" — find matching mobile row model
      const model = rowIndexToModel.get(gItem.index);
      if (!model) return null;
      return renderRowItem(vi, model);
    }

    // --- Flat mode ---
    const model = mobileRows[vi.index];
    if (!model) return null;
    return renderRowItem(vi, model);
  };

  const renderRowItem = (
    vi: (typeof virtualItems)[number],
    model: (typeof mobileRows)[number],
  ) => {
    const row = model.row;

    // Debug footer (only in row children if debug mode)
    const debugContent = isDebugEnabled ? (
      <div className="flex items-center gap-1">
        <DebugDialog
          data={row.original}
          title={`Debug Data - Row ${row.id}`}
          trigger={
            <Button variant="ghost" size="icon-sm">
              <Bug className="h-3 w-3" />
              <span className="sr-only">Debug row data</span>
            </Button>
          }
        />
      </div>
    ) : undefined;

    // Default compact row with right-aligned values
    const card = (
      <MobileCard
        variant="row"
        title={model.title}
        subtitle={model.subtitle}
        imageSlot={
          model.imageSlot ??
          // Recipes have no per-item image; a generic chef-hat on every row
          // is noise. Let the grid collapse and reclaim the 44px gutter.
          (entity && entity !== "recipe" && (
            <div className="flex h-11 w-11 items-center justify-center rounded bg-muted/50">
              <EntityIcon entity={entity} colored className="h-5 w-5" />
            </div>
          ))
        }
        rightValues={model.rightValues}
        selectable={
          isSelectable
            ? {
                isSelected: row.getIsSelected(),
                onSelectionChange: (checked) => row.toggleSelected(checked),
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
      >
        {debugContent}
      </MobileCard>
    );

    return (
      <VirtualRow key={row.id} vi={vi} virtualizer={virtualizer}>
        {swipeActions ? (
          <SwipeRow actions={swipeActions(row)}>{card}</SwipeRow>
        ) : (
          card
        )}
      </VirtualRow>
    );
  };

  return (
    <div className="block overflow-x-hidden lg:hidden">
      {itemCount > 0 ? (
        <div ref={listRef}>
          <div
            style={{
              height: `${virtualizer.getTotalSize()}px`,
              width: "100%",
              position: "relative",
            }}
          >
            {virtualItems.map(renderVirtualItem)}
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
