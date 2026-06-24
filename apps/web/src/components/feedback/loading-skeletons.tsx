import { Skeleton } from "~/components/ui/skeleton";
import { Spinner } from "~/components/ui/spinner";
import { cn } from "~/lib/utils";

// Reusable skeleton patterns built on shadcn Skeleton
function SkeletonText({ className }: { className?: string }) {
  return <Skeleton className={cn("h-4", className)} />;
}

/**
 * One loading row shaped like the ledger it becomes: a short mono-qty bar,
 * a name bar, a trailing value bar, dashed rule below. Widths vary by index
 * so the column doesn't read as a barcode.
 */
function SkeletonLedgerRow({ index }: { index: number }) {
  const nameWidths = ["w-3/5", "w-2/5", "w-1/2", "w-2/3", "w-1/3"];
  return (
    <div className="grid grid-cols-[3.5rem_minmax(0,1fr)_4rem] items-center gap-2 border-border border-b border-dashed py-2">
      <Skeleton className="h-3 w-full" />
      <Skeleton className={cn("h-3", nameWidths[index % nameWidths.length])} />
      <Skeleton className="h-3 w-full" />
    </div>
  );
}

function SkeletonGrid({ count = 6 }: { count?: number }) {
  return (
    <div>
      {Array.from({ length: count }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static list that never reorders
        <SkeletonLedgerRow key={i} index={i} />
      ))}
    </div>
  );
}

// Specific loading patterns
export function ListLoadingSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div className="space-y-4 p-6">
      <SkeletonText className="h-8 w-48" />
      <SkeletonGrid count={count} />
    </div>
  );
}

// Simple loading text with spinner for inline use
export function SimpleLoading({ text = "Loading..." }: { text?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 p-4 font-mono text-2xs text-muted-foreground uppercase tracking-wider">
      <Spinner />
      {text}
    </div>
  );
}
