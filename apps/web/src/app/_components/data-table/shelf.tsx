import type { Entity } from "@cubby/schemas/entity";
import { Link } from "@tanstack/react-router";
import { LayoutGrid, LayoutList } from "lucide-react";
import type { ReactNode } from "react";
import { ErrorDisplay } from "~/components/feedback/error-display";
import { Image } from "~/components/ui/image";
import { Skeleton } from "~/components/ui/skeleton";
import { Spinner } from "~/components/ui/spinner";
import type { ViewSwitcherOption } from "~/components/ui/view-switcher";
import { EntityIcon } from "~/entities/entities";
import { useInfiniteScrollSentinel } from "../hooks/useInfiniteScrollSentinel";
import type { InfiniteScrollControls } from "../hooks/useInfiniteTableList";

export type ShelfView = "shelf" | "table";

export const SHELF_VIEW_OPTIONS: ViewSwitcherOption<ShelfView>[] = [
  { value: "shelf", label: "Shelf", icon: LayoutGrid },
  { value: "table", label: "Table", icon: LayoutList },
];

const SHELF_GRID_CLASS =
  "grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6";

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
}) {
  return (
    <Link
      to={to}
      params={params}
      className="flex flex-col overflow-hidden border border-[var(--border)] bg-card transition-colors duration-150 hover:bg-muted/50"
    >
      <div className="relative aspect-square w-full overflow-hidden bg-muted/20">
        {media ?? (
          <Image
            src={image ?? ""}
            alt={title}
            displayWidth={400}
            className="absolute inset-0 h-full w-full object-cover"
            fallback={<EntityIcon entity={entity} colored className="size-6" />}
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
          className="line-clamp-2 font-medium text-sm leading-tight"
          title={title}
        >
          {title}
        </div>
        {subtitle != null && subtitle !== "" && (
          <div className="mt-1 truncate font-mono text-muted-foreground text-xs">
            {subtitle}
          </div>
        )}
      </div>
    </Link>
  );
}

/** Centered empty state for an empty shelf. */
export function ShelfEmpty({
  entity,
  label,
}: {
  entity: Entity;
  label: string;
}) {
  return (
    <div className="flex items-center justify-center gap-2 py-6 text-muted-foreground text-sm">
      <EntityIcon entity={entity} className="size-4 opacity-40" />
      {label}
    </div>
  );
}

function ShelfSkeleton() {
  return (
    <div className={SHELF_GRID_CLASS}>
      {Array.from({ length: 12 }, (_, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length placeholders
          key={i}
          className="overflow-hidden border border-[var(--border)]"
        >
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
export function ShelfGrid<T>({
  items,
  renderCard,
  isLoading,
  error,
  infiniteScroll,
  emptyState,
}: {
  items: T[];
  /** Must return a keyed element (e.g. a ShelfCard with `key`). */
  renderCard: (item: T) => ReactNode;
  isLoading?: boolean;
  error?: unknown;
  infiniteScroll?: InfiniteScrollControls;
  emptyState?: ReactNode;
}) {
  const sentinelRef = useInfiniteScrollSentinel(infiniteScroll, "400px");

  if (error) {
    return (
      <div className="py-6">
        <ErrorDisplay error={error} />
      </div>
    );
  }

  if (isLoading && items.length === 0) return <ShelfSkeleton />;

  if (items.length === 0) return <>{emptyState}</>;

  return (
    <div aria-busy={infiniteScroll?.isTransitioning ?? false}>
      <div
        className={SHELF_GRID_CLASS}
        inert={infiniteScroll?.isTransitioning ? true : undefined}
      >
        {items.map(renderCard)}
      </div>
      {infiniteScroll?.isTransitioning && (
        <div
          role="status"
          className="flex items-center justify-center gap-1 py-2 text-muted-foreground text-xs"
        >
          <Spinner size="sm" />
          Updating…
        </div>
      )}
      {infiniteScroll && <div ref={sentinelRef} className="h-10" aria-hidden />}
    </div>
  );
}
