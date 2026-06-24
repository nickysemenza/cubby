import { Skeleton } from "~/components/ui/skeleton";

/** Skeleton matching MobileCard row variant layout: [image] [title / subtitle] [action] */
function MobileCardSkeleton() {
  return (
    <div className="grid w-full grid-cols-[auto_1fr_auto] items-center gap-x-2 border-border/30 border-b px-2 py-2">
      {/* Image placeholder */}
      <Skeleton className="h-11 w-11 rounded" />

      {/* Title + subtitle */}
      <div className="min-w-0 space-y-2">
        <Skeleton className="h-3.5 w-3/4" />
        <Skeleton className="h-3 w-1/2" />
      </div>

      {/* Action placeholder */}
      <Skeleton className="h-8 w-8 rounded" />
    </div>
  );
}

export function MobileCardSkeletonList({ count = 8 }: { count?: number }) {
  return (
    <div>
      {Array.from({ length: count }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton list
        <MobileCardSkeleton key={i} />
      ))}
    </div>
  );
}
