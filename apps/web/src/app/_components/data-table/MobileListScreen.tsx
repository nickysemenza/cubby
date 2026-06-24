import type { Entity } from "@cubby/schemas/entity";
import type { Table as ITable, Row } from "@tanstack/react-table";
import { LayoutList, List } from "lucide-react";
import type { ReactNode } from "react";
import type { SwipeAction } from "~/components/entity/swipe-row";
import { ErrorDisplay } from "~/components/feedback/error-display";
import { MobileCardSkeletonList } from "~/components/feedback/mobile-card-skeleton";
import { Button } from "~/components/ui/button";
import { PullToRefresh } from "~/components/ui/pull-to-refresh";
import type { InfiniteScrollControls } from "../hooks/useInfiniteTableList";
import { DataTableToolbar } from "./data-table-toolbar";
import { MobileCardView } from "./MobileCardView";
import type { GroupConfig } from "./useGroupedList";

interface MobileRefreshControls {
  onRefresh: () => Promise<void>;
  isRefreshing: boolean;
}

interface MobileListScreenProps<TItem> {
  table: ITable<TItem>;
  entity?: Entity;
  additionalToolbarContent?: ReactNode;
  actions?: ReactNode;
  bulkActionBar?: ReactNode;
  isLoading?: boolean;
  error?: unknown;
  renderMobileCard?: (row: Row<TItem>, defaultContent: ReactNode) => ReactNode;
  infiniteScroll?: InfiniteScrollControls;
  refreshControls?: MobileRefreshControls;
  /** Group configuration — when provided, shows a toggle button */
  groupConfig?: GroupConfig<TItem>;
  /** Whether grouping is currently active (controlled from parent) */
  grouped?: boolean;
  /** Toggle grouping on/off (controlled from parent) */
  onGroupedChange?: (value: boolean) => void;
  /** Swipe-to-reveal actions per row */
  swipeActions?: (row: Row<TItem>) => SwipeAction[];
}

export function MobileListScreen<TItem>({
  table,
  entity,
  additionalToolbarContent,
  actions,
  bulkActionBar,
  isLoading = false,
  error,
  renderMobileCard,
  infiniteScroll,
  refreshControls,
  groupConfig,
  grouped = false,
  onGroupedChange,
  swipeActions,
}: MobileListScreenProps<TItem>) {
  const groupToggle =
    groupConfig && onGroupedChange ? (
      <Button
        variant="ghost"
        size="icon-lg"
        className="shrink-0"
        onClick={() => onGroupedChange(!grouped)}
        aria-label={grouped ? "Show flat list" : "Show grouped list"}
      >
        {grouped ? (
          <List className="h-4 w-4" />
        ) : (
          <LayoutList className="h-4 w-4" />
        )}
      </Button>
    ) : null;

  const toolbarContent = groupToggle ? (
    <div className="flex items-center gap-2">
      {additionalToolbarContent}
      {groupToggle}
    </div>
  ) : (
    additionalToolbarContent
  );

  return (
    <div className="overflow-x-hidden lg:hidden">
      <DataTableToolbar
        table={table}
        additionalContent={toolbarContent}
        actions={actions}
        bulkActionBar={bulkActionBar}
        showViewOptions={false}
        className="mb-2 flex-wrap overflow-x-hidden"
      />

      {isLoading ? (
        <MobileCardSkeletonList />
      ) : error ? (
        <div className="py-6">
          <ErrorDisplay error={error} />
        </div>
      ) : (
        (() => {
          const cardView = (
            <MobileCardView
              table={table}
              entity={entity}
              renderMobileCard={renderMobileCard}
              infiniteScroll={infiniteScroll}
              groupConfig={groupConfig}
              grouped={grouped}
              swipeActions={swipeActions}
            />
          );
          return refreshControls ? (
            <PullToRefresh
              onRefresh={refreshControls.onRefresh}
              disabled={refreshControls.isRefreshing}
              getScrollTop={() => window.scrollY}
            >
              {cardView}
            </PullToRefresh>
          ) : (
            cardView
          );
        })()
      )}
    </div>
  );
}
