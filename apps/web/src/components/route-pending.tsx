import { PageWrapper } from "~/components/layout/page-wrapper";
import { Skeleton } from "~/components/ui/skeleton";

/** Standard pending/loading component for detail pages.
 * Mirrors the real detail layout (eyebrow + title, then a 2-column card grid)
 * so the transition into the loaded page doesn't jump. */
export function DetailPagePending() {
  return (
    <PageWrapper>
      <div className="space-y-3 sm:space-y-6">
        {/* Header: eyebrow + title */}
        <div className="space-y-2">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-9 w-64" />
        </div>
        {/* 2-column card grid */}
        <div className="grid gap-3 sm:gap-6 md:grid-cols-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-40 w-full rounded-lg" />
          ))}
        </div>
      </div>
    </PageWrapper>
  );
}
