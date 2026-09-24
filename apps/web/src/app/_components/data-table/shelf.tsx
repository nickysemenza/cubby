import type { Entity } from "@cubby/schemas/entity";
import type { ListGroupSummary } from "@cubby/schemas/pagination";
import { ArrowUpRightIcon } from "@phosphor-icons/react/dist/csr/ArrowUpRight";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { ErrorDisplay } from "~/components/feedback/error-display";
import { Button } from "~/components/ui/button";
import { Image } from "~/components/ui/image";
import { Skeleton } from "~/components/ui/skeleton";
import { Spinner } from "~/components/ui/spinner";
import { EntityIcon } from "~/entities/entities";
import { cn } from "~/lib/utils";

import { useInfiniteScrollSentinel } from "../hooks/useInfiniteScrollSentinel";
import type { InfiniteScrollControls } from "../hooks/useInfiniteTableList";
import { orderedGroupSections } from "./useGroupedList";

export interface GroupedFlowGroup<T> {
  id: string;
  label: string;
  count: number;
  items: readonly T[];
}

export function groupedFlowSectionId(groupId: string): string {
  return `grouped-flow-group-${encodeURIComponent(groupId)}`;
}

/**
 * Ordered groups sharing one compact grid. Group markers participate in normal
 * auto-placement so a new group never fills space left before its divider.
 */
export function GroupedFlow<T>({
  groups,
  getItemKey,
  dividerAccentClassName,
  renderItem,
}: {
  groups: readonly GroupedFlowGroup<T>[];
  getItemKey: (item: T) => string;
  dividerAccentClassName?: string;
  renderItem: (
    item: T,
    group: GroupedFlowGroup<T>,
    headingId: string,
  ) => ReactNode;
}) {
  return (
    <div
      className={cn(shelfGridClass(true), "@container/grouped-flow")}
      data-testid="grouped-flow"
    >
      {groups.flatMap((group) => {
        const headingId = `${groupedFlowSectionId(group.id)}-heading`;
        return [
          <div
            key={`${group.id}-divider`}
            id={groupedFlowSectionId(group.id)}
            data-grouped-flow-group={group.id}
            className="col-span-full scroll-mt-28 self-start border-y border-[var(--border)] bg-muted/40 px-2 py-2 md:scroll-mt-24 md:@min-[13rem]/grouped-flow:col-span-2 md:@min-[13rem]/grouped-flow:self-stretch"
          >
            <div className="flex items-baseline gap-2">
              <span
                className={cn(
                  "size-1.5 shrink-0 bg-muted-foreground",
                  dividerAccentClassName,
                )}
                aria-hidden
              />
              <h2
                id={headingId}
                className="text-sm font-semibold text-foreground"
              >
                {group.label}
              </h2>
              <span className="font-mono text-2xs text-muted-foreground tabular-nums">
                {group.count}
              </span>
            </div>
          </div>,
          ...group.items.map((item) => (
            <div
              key={`${group.id}-item-${getItemKey(item)}`}
              data-grouped-flow-item-group={group.id}
              className="min-w-0"
            >
              {renderItem(item, group, headingId)}
            </div>
          )),
        ];
      })}
    </div>
  );
}

/**
 * Card grids adapt to the work surface rather than the viewport: an open
 * desktop inspector simply yields fewer columns. Compact targets about twice
 * the desktop density without making phone targets smaller.
 */
export const shelfGridClass = (compact = false) =>
  compact
    ? "grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(min(100%,6rem),1fr))]"
    : "grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(min(12rem,calc((100%_-_0.5rem)/2)),1fr))]";

/** The largest display transform the standard shelf card needs. */
const SHELF_CARD_DISPLAY_WIDTH = 240;

/** A single image-led card: square photo (with graceful fallback) + caption. */
export function ShelfCard({
  to,
  params,
  image,
  media,
  title,
  subtitle,
  entity,
  extraCount = 0,
  badgeSlot,
  compact = false,
  onInspect,
  onRowHover,
  onRowHoverEnd,
  selected = false,
}: {
  to: string;
  params: Record<string, string>;
  image?: string;
  /** Custom source-aware media; preferred over the single-image fallback. */
  media?: ReactNode;
  title: string;
  subtitle?: ReactNode;
  entity: Entity;
  extraCount?: number;
  /** Small overlay chip in the photo's top-left (e.g. a location-type icon). */
  badgeSlot?: ReactNode;
  compact?: boolean;
  onInspect?: () => void;
  onRowHover?: () => void;
  onRowHoverEnd?: () => void;
  selected?: boolean;
}) {
  return (
    <div
      data-entity-card
      className={cn(
        "relative flex min-w-0 flex-col overflow-hidden border bg-card transition-colors duration-150 hover:bg-muted/50",
        selected
          ? "border-primary ring-1 ring-primary"
          : "border-[var(--border)]",
      )}
      onMouseEnter={onRowHover}
      onMouseLeave={onRowHoverEnd}
    >
      <Link
        to={to}
        params={params}
        aria-label={title}
        aria-current={selected ? "true" : undefined}
        className="flex min-w-0 flex-1 flex-col focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
        onClick={(event) => {
          if (
            !onInspect ||
            event.button !== 0 ||
            event.metaKey ||
            event.ctrlKey ||
            event.altKey ||
            event.shiftKey
          )
            return;
          event.preventDefault();
          onInspect();
        }}
      >
        <div className="relative aspect-square w-full overflow-hidden bg-muted/20">
          {media ?? (
            <Image
              src={image ?? ""}
              alt={title}
              displayWidth={compact ? 128 : SHELF_CARD_DISPLAY_WIDTH}
              className="absolute inset-0 h-full w-full object-cover"
              fallback={
                <EntityIcon entity={entity} colored className="size-6" />
              }
            />
          )}
          {badgeSlot != null && (
            <div className="absolute top-1 left-1 rounded bg-black/60 p-1 text-white">
              {badgeSlot}
            </div>
          )}
          {extraCount > 0 && (
            <div className="absolute right-1 bottom-1 rounded bg-black/60 px-1 text-2xs text-white">
              +{extraCount}
            </div>
          )}
        </div>
        <div className="min-w-0 px-2 py-2">
          <div
            className={cn(
              "line-clamp-2 leading-tight font-medium",
              compact ? "text-xs" : "text-sm",
            )}
            title={title}
          >
            {title}
          </div>
        </div>
      </Link>
      {subtitle != null && subtitle !== "" && (
        <div className="min-w-0 truncate px-2 pb-2 font-mono text-xs text-muted-foreground">
          {subtitle}
        </div>
      )}
      {onInspect && (
        <Link
          to={to}
          params={params}
          aria-label={`Open detail page for ${title}`}
          title={`Open ${title}`}
          className="absolute top-1 right-1 flex size-11 items-center justify-center border border-[var(--border)] bg-card/95 text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring md:size-7"
        >
          <ArrowUpRightIcon className="size-4" />
        </Link>
      )}
    </div>
  );
}

/** Centered empty state for an empty shelf. */
export function ShelfEmpty({
  entity,
  label,
  detail,
}: {
  entity: Entity;
  label: string;
  /**
   * A second line under the label, for an empty state that can say WHERE the
   * thing actually is rather than only that it is not here.
   */
  detail?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-1 py-6 text-sm text-muted-foreground">
      <div className="flex items-center gap-2">
        <EntityIcon entity={entity} className="size-4 opacity-40" />
        {label}
      </div>
      {detail}
    </div>
  );
}

function ShelfSkeleton({ compact = false }: { compact?: boolean }) {
  return (
    <div className={shelfGridClass(compact)}>
      {Array.from({ length: 12 }, (_, i) => (
        <div key={i} className="overflow-hidden border border-[var(--border)]">
          <Skeleton className="aspect-square w-full rounded-none" />
          <div className="space-y-2 px-2 py-2">
            <Skeleton className="h-3.5 w-3/4" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Photo-first "shelf" grid with loading / empty / error states and optional
 * infinite-scroll. The reusable half of the Shelf/Table pattern — feed it items
 * and a `renderCard` (use ShelfCard) and pair it with `ViewSwitcher`.
 */
function shelfItems<T>(
  items: T[],
  renderCard: (item: T) => ReactNode,
  groups?: readonly { key: string; label: string; count: number }[],
  getGroupKey?: (item: T) => string | null | undefined,
): ReactNode[] {
  if (!groups) return items.map(renderCard);
  const groupedItems = new Map<string, T[]>();
  for (const item of items) {
    const key = getGroupKey?.(item) ?? "(unspecified)";
    const section = groupedItems.get(key);
    if (section) section.push(item);
    else groupedItems.set(key, [item]);
  }
  return orderedGroupSections(groupedItems, groups).flatMap((group) => [
    <div
      key={`group-${group.key}`}
      className="col-span-full flex items-baseline gap-2 border-y border-[var(--border)] bg-muted/40 px-2 py-2"
    >
      <h2 className="text-sm font-semibold text-foreground">{group.label}</h2>
      <span className="text-2xs text-muted-foreground tabular-nums">
        {group.count}
      </span>
    </div>,
    ...group.items.map(renderCard),
  ]);
}

export function ShelfGrid<T>({
  items,
  renderCard,
  groups,
  getGroupKey,
  isLoading,
  error,
  infiniteScroll,
  emptyState,
  compact = false,
  onRetry,
}: {
  items: T[];
  /** Must return a keyed element (e.g. a ShelfCard with `key`). */
  renderCard: (item: T) => ReactNode;
  groups?: readonly ListGroupSummary[];
  getGroupKey?: (item: T) => string | null | undefined;
  isLoading?: boolean;
  error?: unknown;
  infiniteScroll?: InfiniteScrollControls;
  emptyState?: ReactNode;
  /** Local-only density choice; URL selection remains the shelf view. */
  compact?: boolean;
  onRetry?: () => void;
}) {
  const sentinelRef = useInfiniteScrollSentinel(infiniteScroll, "400px");
  const failure = error ? (
    <div className="space-y-2 py-3">
      <ErrorDisplay error={error} />
      {onRetry && (
        <Button variant="outline" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  ) : null;
  if (error && items.length === 0) return failure;

  if (isLoading && items.length === 0)
    return <ShelfSkeleton compact={compact} />;

  if (items.length === 0 && !groups?.length) return <>{emptyState}</>;

  return (
    <div aria-busy={infiniteScroll?.isTransitioning ?? false}>
      {failure}
      <div
        className={shelfGridClass(compact)}
        data-testid="entity-card-grid"
        data-compact={compact ? "true" : "false"}
        inert={infiniteScroll?.isTransitioning ? true : undefined}
      >
        {shelfItems(items, renderCard, groups, getGroupKey)}
      </div>
      {infiniteScroll?.isTransitioning && (
        <output className="flex items-center justify-center gap-1 py-2 text-xs text-muted-foreground">
          <Spinner size="sm" />
          Updating…
        </output>
      )}
      {infiniteScroll && <div ref={sentinelRef} className="h-10" aria-hidden />}
    </div>
  );
}
