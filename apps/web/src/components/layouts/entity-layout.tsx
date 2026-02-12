import { type ReactNode, Suspense } from "react";
import { ListLoadingSkeleton } from "~/components/feedback/loading-skeletons";
import { PageWrapper } from "~/components/layout/page-wrapper";
import { HydrateClient } from "~/trpc/hydrate-client";

interface EntityLayoutProps {
  children: ReactNode;
  title?: string;
  actions?: ReactNode;
  fullWidth?: boolean;
}

export function EntityLayout({
  children,
  title,
  actions,
  fullWidth,
}: EntityLayoutProps) {
  return (
    <HydrateClient>
      <PageWrapper fullWidth={fullWidth}>
        {(title || actions) && (
          <div className="mb-6 flex flex-wrap items-center justify-between gap-2">
            {title && <h1 className="font-bold text-2xl">{title}</h1>}
            {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
          </div>
        )}
        <Suspense fallback={<ListLoadingSkeleton />}>{children}</Suspense>
      </PageWrapper>
    </HydrateClient>
  );
}
