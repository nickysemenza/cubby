import type { Entity } from "@cubby/schemas/entity";
import type { RowData } from "@tanstack/react-table";
import { LayoutList, List } from "lucide-react";
import { type ReactNode, useRef } from "react";

import { ErrorDisplay } from "~/components/feedback/error-display";
import { MobileCardSkeletonList } from "~/components/feedback/mobile-card-skeleton";
import { Button } from "~/components/ui/button";
import { PullToRefresh } from "~/components/ui/pull-to-refresh";
import { useHydrated } from "~/hooks/useHydrated";
import { cn } from "~/lib/utils";

import type { InfiniteScrollControls } from "../hooks/useInfiniteTableList";
import { DataTableToolbar } from "./data-table-toolbar";
import { MobileCardView } from "./MobileCardView";
import { MobileSortSheet } from "./MobileSortSheet";
import type { CubbyTable as ITable } from "./table-features";
import type { GroupConfig } from "./useGroupedList";
import { mobileListShape } from "./useMobileListModel";
import type { TableDensity } from "./useTableDensity";

interface MobileRefreshControls {
  onRefresh: () => Promise<void>;
  isRefreshing: boolean;
}

interface MobileListScreenProps<TItem extends RowData> {
  table: ITable<TItem>;
  entity?: Entity;
  getDetailsHref?: (item: TItem) => string | undefined;
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
  defaultDensity?: TableDensity;
}

export function MobileListScreen<TItem extends RowData>({
  table,
  entity,
  getDetailsHref,
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
  defaultDensity,
}: MobileListScreenProps<TItem>) {
  const listRef = useRef<HTMLDivElement>(null);
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
      ref={listRef}
      className={cn(
        "overflow-x-hidden lg:hidden",
        // Pre-hydration this renders on EVERY viewport (the desktop path is
        // still the JS default), so the breakpoint — not `useIsMobile` — has to
        // be what hides it from desktop for that one pass.
        !hydrated && "md:hidden",
      )}
    >
      <DataTableToolbar
        table={table}
        defaultDensity={defaultDensity}
        additionalContent={toolbarContent}
        actions={actions}
        bulkActionBar={bulkActionBar}
        showViewOptions={portalWorkbenchUtilities}
        portalWorkbenchUtilities={portalWorkbenchUtilities}
        workbenchUtilityViewport="mobile"
        className="mb-0 flex-wrap overflow-x-hidden border-b border-border"
        isTransitioning={isTransitioning}
      />

      {isLoading || !hydrated ? (
        <MobileCardSkeletonList {...mobileListShape(table)} />
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
              getDetailsHref={getDetailsHref}
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

      {/* After the list, so the trigger is the last thing in tab order rather
          than something a keyboard user crosses on the way into the rows. */}
      <MobileSortSheet
        table={table}
        listRef={listRef}
        disabled={isLoading || !hydrated || Boolean(error) || isTransitioning}
      />
    </div>
  );
}
