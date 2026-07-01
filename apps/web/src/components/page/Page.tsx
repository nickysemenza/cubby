import type { Entity } from "@cubby/schemas/entity";
import { type ReactNode, Suspense } from "react";
import { ListLoadingSkeleton } from "~/components/feedback/loading-skeletons";
import { PageWrapper } from "~/components/layout/page-wrapper";
import {
  type DetailHeroStat,
  PageHeader,
} from "~/components/layouts/page-hero";
import { useRouteEntity } from "~/hooks/useRouteEntity";
import { HydrateClient } from "~/trpc/hydrate-client";

interface PageBaseProps {
  /** Page title — the big heading (list) or the spec-plate name (detail). */
  title: ReactNode;
  /** Override the auto-derived eyebrow. */
  eyebrow?: ReactNode;
  /** Right-aligned action cluster on the header. */
  actions?: ReactNode;
  /** Let very wide content breathe instead of capping at the readable column. */
  fullWidth?: boolean;
  children: ReactNode;
}

interface PageListProps extends PageBaseProps {
  /** "list" (default) renders the list header. */
  variant?: "list";
  /** Entity drives the eyebrow path + accent bar. */
  entity?: Entity;
  /** Smaller title for utility pages (e.g. Ask). */
  compact?: boolean;
  /** "none" drops the ultramarine accent rule under the title. */
  decoration?: "accent" | "none";
}

interface PageDetailProps extends PageBaseProps {
  variant: "detail";
  /** Required on detail — drives the spec-plate eyebrow + ink spine. */
  entity: Entity;
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
 * Discriminated union — `variant="detail"` requires `entity` at compile time
 * (the spec-plate can't render without it), so callers get a TS error instead of
 * the runtime guard in {@link PageHeader}.
 */
type PageProps = PageListProps | PageDetailProps;

/**
 * The single page shell for both list and detail pages: client hydration, the
 * width container, the unified {@link PageHeader} (list header or detail
 * spec-plate), and a Suspense boundary around the page body.
 */
export function Page(props: PageProps) {
  const { title, eyebrow, actions, fullWidth, children } = props;
  const variant = props.variant ?? "list";
  // List pages can omit `entity` — derive it from the route so the eyebrow/accent
  // still render. Detail pages always pass it explicitly (TS-required).
  const autoEntity = useRouteEntity();
  const entity = props.entity ?? autoEntity;
  // Detail-only spec-plate extras, narrowed off the union.
  const detail = props.variant === "detail" ? props : undefined;
  // List-only header options, narrowed off the union.
  const list = props.variant !== "detail" ? props : undefined;
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
            compact={list?.compact}
            decoration={list?.decoration}
            heroStamp={detail?.heroStamp}
            heroStats={detail?.heroStats}
            heroNo={detail?.heroNo}
            heroImages={detail?.heroImages}
            rawData={detail?.rawData}
          />
          <Suspense fallback={<ListLoadingSkeleton />}>{children}</Suspense>
        </div>
      </PageWrapper>
    </HydrateClient>
  );
}
