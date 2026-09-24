import type { Entity } from "@cubby/schemas/entity";
import { ListIcon as List } from "@phosphor-icons/react/dist/csr/List";
import { ListDashesIcon as LayoutList } from "@phosphor-icons/react/dist/csr/ListDashes";
import type { RowData } from "@tanstack/react-table";
import type { ReactNode } from "react";

import { ErrorDisplay } from "~/components/feedback/error-display";
import { MobileCardSkeletonList } from "~/components/feedback/mobile-card-skeleton";
import { Button } from "~/components/ui/button";
import { PullToRefresh } from "~/components/ui/pull-to-refresh";
import { useHydrated } from "~/hooks/useHydrated";
import { cn } from "~/lib/utils";

import type { InfiniteScrollControls } from "../hooks/useInfiniteTableList";
import { DataTableToolbar } from "./data-table-toolbar";
import { MobileCardView } from "./MobileCardView";
import type { CubbyRow as Row, CubbyTable as ITable } from "./table-features";
import type { GroupConfig } from "./useGroupedList";
import { mobileListLayout } from "./useMobileListModel";

interface MobileRefreshControls {
  onRefresh: () => Promise<void>;
  isRefreshing: boolean;
}

interface MobileListScreenProps<TItem extends RowData> {
  table: ITable<TItem>;
  onRowClick?: (row: Row<TItem>) => void;
  entity?: Entity;
  getDetailsHref?: (item: TItem) => string | undefined;
  disableDetailsHref?: boolean;
  renderRowFooter?: (item: TItem) => ReactNode;
  additionalToolbarContent?: ReactNode;
  actions?: ReactNode;
  bulkActionBar?: ReactNode;
  isLoading?: boolean;
  error?: unknown;
  infiniteScroll?: InfiniteScrollControls;
  refreshControls?: MobileRefreshControls;
  /** Group configuration — when provided, shows a toggle button */
  groupConfig?: GroupConfig<TItem>;
  /** Whether grouping is currently active (controlled from parent) */
  grouped?: boolean;
  /** Toggle grouping on/off (controlled from parent) */
  onGroupedChange?: (value: boolean) => void;
  isTransitioning?: boolean;
  /** External cell-render state snapshot; see useTableConfig. */
  rowContentVersion?: unknown;
  portalWorkbenchUtilities?: boolean;
  emptyState?: ReactNode;
  showToolbar?: boolean;
  showViewOptions?: boolean;
  toolbarVariant?: "page" | "embedded";
}

export function MobileListScreen<TItem extends RowData>({
  table,
  onRowClick,
  entity,
  getDetailsHref,
  disableDetailsHref,
  renderRowFooter,
  additionalToolbarContent,
  actions,
  bulkActionBar,
  isLoading = false,
  error,
  infiniteScroll,
  refreshControls,
  groupConfig,
  grouped = false,
  onGroupedChange,
  isTransitioning = false,
  rowContentVersion,
  portalWorkbenchUtilities = false,
  emptyState,
  showToolbar = true,
  showViewOptions = false,
  toolbarVariant = "page",
}: MobileListScreenProps<TItem>) {
  // `useIsMobile` reports false until hydration (its server snapshot has to, to
  // keep SSR markup stable), so before that the only mobile-correct thing this
  // component can render is the shape of the list to come — see the `md:hidden`
  // gate below, which is what keeps it off desktop while JS is still catching
  // up. Without it a phone's first paint is a clipped desktop table.
  const hydrated = useHydrated();

  const groupToggle =
    groupConfig && onGroupedChange ? (
      <Button
        variant="ghost"
        size="icon-lg"
        className="size-11 shrink-0"
        onClick={() => onGroupedChange(!grouped)}
        aria-label={grouped ? "Show flat list" : "Show grouped list"}
      >
        {grouped ? (
          <List className="size-4" />
        ) : (
          <LayoutList className="size-4" />
        )}
      </Button>
    ) : null;

  // The desktop table header doesn't render filter controls; this shared
  // toolbar gives phones the same filter builder.
  const toolbarContent = (
    <div className="flex items-center gap-2">
      {additionalToolbarContent}
      {groupToggle}
    </div>
  );

  return (
    <div
      className={cn(
        "overflow-x-hidden lg:hidden",
        // Pre-hydration this renders on EVERY viewport (the desktop path is
        // still the JS default), so the breakpoint — not `useIsMobile` — has to
        // be what hides it from desktop for that one pass.
        !hydrated && "md:hidden",
      )}
    >
      {showToolbar && (
        <DataTableToolbar
          table={table}
          entity={entity}
          additionalContent={toolbarContent}
          actions={actions}
          bulkActionBar={bulkActionBar}
          showViewOptions={showViewOptions}
          portalWorkbenchUtilities={portalWorkbenchUtilities}
          workbenchUtilityViewport="mobile"
          variant={toolbarVariant}
          className="mb-0 flex-wrap overflow-x-hidden border-b border-border"
          isTransitioning={isTransitioning}
        />
      )}

      {Boolean(error) && (
        <div className="py-6">
          <ErrorDisplay error={error} onRetry={refreshControls?.onRefresh} />
        </div>
      )}
      {isLoading || !hydrated ? (
        <MobileCardSkeletonList {...mobileListLayout(table)} />
      ) : error && table.getRowModel().rows.length === 0 ? null : (
        (() => {
          const cardView = (
            <MobileCardView
              table={table}
              onRowClick={onRowClick}
              entity={entity}
              getDetailsHref={getDetailsHref}
              disableDetailsHref={disableDetailsHref}
              renderRowFooter={renderRowFooter}
              infiniteScroll={infiniteScroll}
              groupConfig={groupConfig}
              grouped={grouped}
              isTransitioning={isTransitioning}
              rowContentVersion={rowContentVersion}
              emptyState={emptyState}
            />
          );
          return refreshControls ? (
            <PullToRefresh
              onRefresh={refreshControls.onRefresh}
              disabled={refreshControls.isRefreshing || isTransitioning}
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
