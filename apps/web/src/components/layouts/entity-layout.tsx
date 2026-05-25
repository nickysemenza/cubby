import { type ReactNode, Suspense } from "react";
import { ListLoadingSkeleton } from "~/components/feedback/loading-skeletons";
import { PageWrapper } from "~/components/layout/page-wrapper";
import type { Entity } from "~/entities/types";
import { HydrateClient } from "~/trpc/hydrate-client";
import { PageHero } from "./page-hero";

interface EntityLayoutProps {
  children: ReactNode;
  title?: string;
  actions?: ReactNode;
  fullWidth?: boolean;
  /** Optional entity for the hero — currently informational; reserved for future detail-variant usage. */
  entity?: Entity;
}

export function EntityLayout({
  children,
  title,
  actions,
  fullWidth,
  entity,
}: EntityLayoutProps) {
  return (
    <HydrateClient>
      <PageWrapper fullWidth={fullWidth}>
        {(title || actions) && (
          <PageHero
            variant="list"
            title={title ?? ""}
            actions={actions}
            entity={entity}
          />
        )}
        <Suspense fallback={<ListLoadingSkeleton />}>{children}</Suspense>
      </PageWrapper>
    </HydrateClient>
  );
}
