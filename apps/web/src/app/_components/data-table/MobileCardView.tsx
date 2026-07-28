import type { Entity } from "@cubby/schemas/entity";
import { useNavigate } from "@tanstack/react-router";
import type { Table as ITable } from "@tanstack/react-table";
import { useWindowVirtualizer } from "@tanstack/react-virtual";
import { Bug } from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { MobileCard } from "~/components/entity/mobile-card";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { useDebug } from "~/hooks/useDebug";
import { useInfiniteScrollSentinel } from "../hooks/useInfiniteScrollSentinel";
import type { InfiniteScrollControls } from "../hooks/useInfiniteTableList";
import { DebugDialog } from "./DebugDialog";
import { EntityEmptyState, hasActiveFilters } from "./entity-empty-states";
import { SectionHeader } from "./SectionHeader";
import type { GroupConfig } from "./useGroupedList";
import { useGroupedList } from "./useGroupedList";
import {
  estimateMobileRowHeight,
  useMobileListModel,
} from "./useMobileListModel";

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
}

export function MobileCardView<TItem>({
  table,
  entity,
  infiniteScroll,
  groupConfig,
  grouped = false,
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
  // Estimated per row, not as one constant: rows now range from ~55px (no spec
  // values) to ~152px (a fully-populated purchase), and a flat guess that far
  // off makes getTotalSize() lurch as measurements land during a fast scroll.
  const estimateSize = useCallback(
    (index: number) => {
      if (groupedItems) {
        const item = groupedItems[index];
        if (!item) return 56;
        if (item.kind === "header") return 36;
        return estimateMobileRowHeight(rowIndexToModel.get(item.index));
      }
      return estimateMobileRowHeight(mobileRows[index]);
    },
    [groupedItems, mobileRows, rowIndexToModel],
  );

  // Ref for scrollMargin offset calculation
  const listRef = useRef<HTMLDivElement>(null);

  // Window virtualizer — scrolls against the window, not a container
  const virtualizer = useWindowVirtualizer({
    count: itemCount,
    estimateSize,
    // A count, not a pixel budget — and rows got ~2.5x taller, each carrying
    // several edit-triggers. 8 would now hold far more (and heavier) DOM than
    // it did; 4 still covers ~600px on the dense lists.
    overscan: 4,
    scrollMargin: listRef.current?.offsetTop ?? 0,
  });

  const sentinelRef = useInfiniteScrollSentinel(infiniteScroll, "200px");
  const isFetchingNextPage = infiniteScroll?.isFetchingNextPage ?? false;

  // Check if table has row selection enabled
  const hasRowSelection = table.options.enableRowSelection !== false;
  const hasSelectColumn = table
    .getAllColumns()
    .some((col) => col.id === "select");
  const isSelectable = hasRowSelection && hasSelectColumn;

  // Checkboxes are a 44px gutter on EVERY row for an action most taps never
  // take, so selection is a mode: long-press a row to enter it (the iOS
  // convention), and it ends when the last row is deselected.
  const [selectionArmed, setSelectionArmed] = useState(false);
  const anySelected = table.getSelectedRowModel().rows.length > 0;
  const selectionMode = isSelectable && (selectionArmed || anySelected);
  useEffect(() => {
    if (!anySelected) setSelectionArmed(false);
  }, [anySelected]);

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
              <Bug className="size-3" />
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
        // No generic entity-icon fallback: a chef hat (or package, or receipt)
        // repeated down every row is decoration, not information, and it costs
        // the same 44px the real thumbnails use.
        imageSlot={model.imageSlot}
        rightValues={model.rightValues}
        rightValueInteractive={model.rightValueInteractive}
        metaValues={model.metaValues}
        selectable={
          selectionMode
            ? {
                isSelected: row.getIsSelected(),
                onSelectionChange: (checked) => row.toggleSelected(checked),
              }
            : undefined
        }
        onLongPress={
          isSelectable && !selectionMode
            ? () => {
                setSelectionArmed(true);
                row.toggleSelected(true);
              }
            : undefined
        }
        actions={model.actionsContent}
        entity={entity}
        onClick={
          // In selection mode a tap toggles the row rather than navigating —
          // the iOS convention, and otherwise picking a second row means
          // hitting a 20px checkbox instead of the row you're looking at.
          selectionMode
            ? () => row.toggleSelected(!row.getIsSelected())
            : model.detailsHref
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
        {card}
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
