import { type ReactNode, Suspense } from "react";
import { ListLoadingSkeleton } from "~/components/feedback/loading-skeletons";
import { PageWrapper } from "~/components/layout/page-wrapper";
import { HydrateClient } from "~/trpc/hydrate-client";

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
            {title && <h1 className="font-bold text-2xl">{title}</h1>}
            {actions && <div className="flex gap-2">{actions}</div>}
          </div>
        )}
        <Suspense fallback={<ListLoadingSkeleton />}>{children}</Suspense>
      </PageWrapper>
    </HydrateClient>
  );
}

// Specific variants for different page types (removed unused export)
