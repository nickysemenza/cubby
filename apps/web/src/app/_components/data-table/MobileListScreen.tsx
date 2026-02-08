import type { Entity } from "@cubby/schemas/entity";
import type { Table as ITable, Row } from "@tanstack/react-table";
import type { ReactNode } from "react";
import { ErrorDisplay } from "~/components/feedback/error-display";
import { SimpleLoading } from "~/components/feedback/loading-skeletons";
import { PullToRefresh } from "~/components/ui/pull-to-refresh";
import type { InfiniteScrollControls } from "../hooks/useInfiniteTableList";
import { DataTableToolbar } from "./data-table-toolbar";
import { MobileCardView } from "./MobileCardView";

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
}: MobileListScreenProps<TItem>) {
  return (
    <div className="overflow-x-hidden lg:hidden">
      <DataTableToolbar
        table={table}
        additionalContent={additionalToolbarContent}
        actions={actions}
        bulkActionBar={bulkActionBar}
        showViewOptions={false}
        className="mb-3 flex-wrap overflow-x-hidden rounded-lg border border-border/50 bg-muted/30 px-3 py-2"
      />

      {isLoading ? (
        <SimpleLoading />
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
            />
          );
          return refreshControls ? (
            <PullToRefresh
              onRefresh={refreshControls.onRefresh}
              disabled={refreshControls.isRefreshing}
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
