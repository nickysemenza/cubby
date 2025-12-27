import { PageWrapper } from "~/components/layout/page-wrapper";
import { Skeleton } from "~/components/ui/skeleton";

/** Standard pending/loading component for detail pages */
export function DetailPagePending() {
  return (
    <PageWrapper>
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-32 w-full" />
      </div>
    </PageWrapper>
  );
}
