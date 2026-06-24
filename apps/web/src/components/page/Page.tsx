import type { Entity } from "@cubby/schemas/entity";
import { type ReactNode, Suspense } from "react";
import { ListLoadingSkeleton } from "~/components/feedback/loading-skeletons";
import { PageWrapper } from "~/components/layout/page-wrapper";
import {
  type DetailHeroStat,
  PageHeader,
} from "~/components/layouts/page-hero";
import { HydrateClient } from "~/trpc/hydrate-client";

interface PageProps {
  /** Page title — the big heading (list) or the spec-plate name (detail). */
  title: ReactNode;
  /** Override the auto-derived eyebrow (list variant only). */
  eyebrow?: ReactNode;
  /** Entity drives the eyebrow path / accent (list) and spine color (detail). */
  entity?: Entity;
  /** Right-aligned action cluster on the header. */
  actions?: ReactNode;
  /** "list" (default) renders the list header; "detail" the spec-plate hero. */
  variant?: "list" | "detail";
  /** Let very wide content breathe instead of capping at the readable column. */
  fullWidth?: boolean;
  children: ReactNode;

  // Detail-only spec-plate extras.
  /** Status stamp on the plate (e.g. IN STOCK). */
  heroStamp?: { label: string; tone?: "ink" | "red" | "green" };
  /** Inline ledger stats strip (on hand, value, ...). */
  heroStats?: DetailHeroStat[];
  /** Reference code shown in the eyebrow (e.g. the product shortcode). */
  heroNo?: string;
  /** Images shown as a swipeable hero gallery on mobile. */
  heroImages?: Array<{ id: string; url: string; filename: string }>;
  /** Raw entity used for the "On file since" ledger line. */
  rawData?: unknown;
}

/**
 * The single page shell for both list and detail pages: client hydration, the
 * width container, the unified {@link PageHeader} (list header or detail
 * spec-plate), and a Suspense boundary around the page body.
 */
export function Page({
  title,
  eyebrow,
  entity,
  actions,
  variant = "list",
  fullWidth,
  children,
  heroStamp,
  heroStats,
  heroNo,
  heroImages,
  rawData,
}: PageProps) {
  return (
    <HydrateClient>
      <PageWrapper fullWidth={fullWidth}>
        <div className={variant === "detail" ? "space-y-2" : undefined}>
          <PageHeader
            variant={variant}
            title={title}
            eyebrow={eyebrow}
            entity={entity}
            actions={actions}
            heroStamp={heroStamp}
            heroStats={heroStats}
            heroNo={heroNo}
            heroImages={heroImages}
            rawData={rawData}
          />
          <Suspense fallback={<ListLoadingSkeleton />}>{children}</Suspense>
        </div>
      </PageWrapper>
    </HydrateClient>
  );
}
