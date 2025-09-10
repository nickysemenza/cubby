import { ReactNode, Suspense } from "react";
import { HydrateClient } from "~/trpc/server";
import { PageWrapper } from "~/components/ui/page-wrapper";
import { ListLoadingSkeleton } from "~/components/ui/loading-skeletons";

interface EntityLayoutProps {
  children: ReactNode;
  title?: string;
  actions?: ReactNode;
}

export function EntityLayout({ children, title, actions }: EntityLayoutProps) {
  return (
    <HydrateClient>
      <PageWrapper>
        {(title || actions) && (
          <div className="mb-6 flex items-center justify-between">
            {title && <h1 className="text-2xl font-bold">{title}</h1>}
            {actions && <div className="flex gap-2">{actions}</div>}
          </div>
        )}
        <Suspense fallback={<ListLoadingSkeleton />}>{children}</Suspense>
      </PageWrapper>
    </HydrateClient>
  );
}

// Specific variants for different page types
export function DetailLayout({ children }: { children: ReactNode }) {
  return (
    <HydrateClient>
      <PageWrapper>
        <Suspense fallback={<ListLoadingSkeleton />}>{children}</Suspense>
      </PageWrapper>
    </HydrateClient>
  );
}
