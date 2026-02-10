import type { Entity } from "@cubby/schemas/entity";
import type { Table as ITable, Row } from "@tanstack/react-table";
import { LayoutList, List } from "lucide-react";
import type { ReactNode } from "react";
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
}: MobileListScreenProps<TItem>) {
  const groupToggle =
    groupConfig && onGroupedChange ? (
      <Button
        variant="ghost"
        size="sm"
        className="h-8 w-8 shrink-0 p-0"
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
        className="mb-3 flex-wrap overflow-x-hidden rounded-lg border border-border/50 bg-muted/30 px-3 py-2"
      />

      {isLoading ? (
        <MobileCardSkeletonList />
      ) : error ? (
        <div className="py-8">
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
