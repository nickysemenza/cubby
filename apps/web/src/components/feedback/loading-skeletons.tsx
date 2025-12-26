import { cn } from "~/lib/utils";
import { Skeleton } from "~/components/ui/skeleton";

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

export function DetailLoadingSkeleton() {
  return (
    <div className="space-y-6 p-6">
      {/* Title */}
      <Skeleton className="h-10 w-64" />

      {/* Hero section */}
      <div className="flex space-x-6">
        <Skeleton className="h-48 w-48" />
        <div className="flex-1 space-y-4">
          <SkeletonText />
          <SkeletonText className="w-3/4" />
          <SkeletonText className="w-1/2" />
        </div>
      </div>

      {/* Content sections */}
      <div className="space-y-4">
        <SkeletonText className="h-6 w-32" />
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className="space-y-2">
            <SkeletonText className="w-40" />
            <div className="ml-4 space-y-1">
              {Array.from({ length: 4 }, (_, j) => (
                <SkeletonText key={j} className="h-3 w-48" />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// Simple loading text for inline use
export function SimpleLoading({ text = "Loading..." }: { text?: string }) {
  return (
    <div className="text-muted-foreground flex items-center justify-center p-4">
      {text}
    </div>
  );
}
