import type { Entity } from "@cubby/schemas/entity";
import type { Table as ITable } from "@tanstack/react-table";
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
import type { GroupConfig } from "./useGroupedList";
import { mobileListShape } from "./useMobileListModel";

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
  infiniteScroll?: InfiniteScrollControls;
  refreshControls?: MobileRefreshControls;
  /** Group configuration — when provided, shows a toggle button */
  groupConfig?: GroupConfig<TItem>;
  /** Whether grouping is currently active (controlled from parent) */
  grouped?: boolean;
  /** Toggle grouping on/off (controlled from parent) */
  onGroupedChange?: (value: boolean) => void;
  isTransitioning?: boolean;
  /**
   * Carry the page's identity on the mobile toolbar. Mirrors the desktop
   * pane's flag: `Page` drops its header for `headerInToolbar` at EVERY
   * viewport, and after hydration the desktop pane is not in the DOM, so
   * without this a phone renders the page with no name and no `<h1>` at all.
   */
  ownsPageIdentity?: boolean;
  /** External cell-render state snapshot; see useTableConfig. */
  rowContentVersion?: unknown;
}

export function MobileListScreen<TItem>({
  table,
  entity,
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
  ownsPageIdentity = false,
  rowContentVersion,
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
        additionalContent={toolbarContent}
        actions={actions}
        bulkActionBar={bulkActionBar}
        showViewOptions={false}
        ownsPageIdentity={ownsPageIdentity}
        className="mb-2 flex-wrap overflow-x-hidden"
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
              infiniteScroll={infiniteScroll}
              groupConfig={groupConfig}
              grouped={grouped}
              isTransitioning={isTransitioning}
              rowContentVersion={rowContentVersion}
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
