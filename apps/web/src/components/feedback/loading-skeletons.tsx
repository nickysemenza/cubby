import { Skeleton } from "~/components/ui/skeleton";
import { Spinner } from "~/components/ui/spinner";
import { cn } from "~/lib/utils";

// Reusable skeleton patterns built on shadcn Skeleton
function SkeletonText({ className }: { className?: string }) {
  return <Skeleton className={cn("h-4", className)} />;
}

function SkeletonCard() {
  return (
    <div className="flex items-center space-x-4">
      <Skeleton className="h-12 w-12" />
      <div className="flex-1 space-y-2">
        <SkeletonText />
        <SkeletonText className="w-2/3" />
      </div>
    </div>
  );
}

function SkeletonGrid({ count = 6 }: { count?: number }) {
  return (
    <div className="space-y-3">
      {Array.from({ length: count }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static list that never reorders
        <SkeletonCard key={i} />
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
    <div className="flex items-center justify-center gap-2 p-4 text-muted-foreground">
      <Spinner />
      {text}
    </div>
  );
}
