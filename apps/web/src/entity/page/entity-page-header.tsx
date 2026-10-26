import { entitySchema, type Entity } from "@cubby/schemas/entity";
import {
  detailBreadcrumbSchema,
  type DetailBreadcrumb as DetailBreadcrumbProjection,
} from "@cubby/schemas/entity-detail-summary";
import type { ImageUrlSummary } from "@cubby/schemas/image-summary";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { z } from "zod";

import { EntityCover } from "~/entity/components/entity-cover";
import { entityHeroWhen } from "~/entity/display/entity-display";
import {
  entities,
  entityDetailParams,
  isBrowserRoutedEntity,
} from "~/entity/entities";
import { getEntityNavGroup } from "~/entity/navigation/nav-items";
import { formatCount } from "~/lib/number-format";
import { cn } from "~/lib/utils";
import { CopyableShortcode } from "~/ui/common/copyable-shortcode";
import { DateDisplay } from "~/ui/common/date-display";
import { ImageChainPopover } from "~/ui/derived/image-chain";
import { PageHeader } from "~/ui/layout/page-header";
import {
  domainForEntity,
  domainWayfinding,
  type WayfindingDomain,
} from "~/ui/navigation/domain-wayfinding";
import { Badge, type BadgeVariant } from "~/ui/primitives/badge";

/** Authored action hierarchy for a record header. */
export interface DetailHeroActions {
  /** The single action that should remain visible on every viewport. */
  primary?: ReactNode;
  /**
   * One workflow action and overflow. The caller owns their availability and
   * dialogs; the header supplies wrapping without a second popover.
   */
  secondary?: ReactNode;
}

export interface DetailWayfinding {
  label: string;
  domain: WayfindingDomain | null;
}

/** `heroStamp`'s tone, as a `Badge` variant. */
const heroStampVariant = {
  ink: "secondary",
  red: "destructive",
  green: "positive",
} as const satisfies Record<"ink" | "red" | "green", BadgeVariant>;

const detailRawDataSchema = z
  .object({
    createdAt: z.union([z.string(), z.date()]).optional(),
    breadcrumb: detailBreadcrumbSchema.optional(),
  })
  .passthrough();

function Separator() {
  return <span aria-hidden>/</span>;
}

/**
 * `Pantry / Products / Garage / Shelf B / 4K7M`: the entity's domain (or nav
 * group), its plural label linking back to the list, the record's projected
 * `breadcrumb`, and the copyable code as the current leaf. The code repeats in
 * the facts line below `md`, so the trail hides it there.
 */
function DetailBreadcrumb({
  entity,
  heroNo,
  wayfinding,
  crumbs,
}: {
  entity: Entity;
  heroNo?: string;
  wayfinding?: DetailWayfinding;
  crumbs: DetailBreadcrumbProjection;
}) {
  if (!isBrowserRoutedEntity(entity)) return null;
  const def = entities[entity];
  const domain = wayfinding ? wayfinding.domain : domainForEntity(entity);
  const leadingLabel =
    wayfinding?.label ??
    (domain
      ? domainWayfinding(domain).label
      : getEntityNavGroup(entity)?.label);
  return (
    <nav
      aria-label="Breadcrumb"
      className="flex flex-wrap items-center gap-x-1 gap-y-1"
    >
      {leadingLabel && (
        <>
          <span>{leadingLabel}</span>
          <Separator />
        </>
      )}
      <Link
        to={def.routes.list}
        className={cn(
          "hover:text-foreground",
          heroNo ? "text-muted-foreground" : "text-foreground",
        )}
      >
        {def.pluralLabel}
      </Link>
      {crumbs.map((crumb) => {
        const parsed = entitySchema.safeParse(crumb.entity);
        return (
          <span key={crumb.id} className="inline-flex items-center gap-x-1">
            <Separator />
            {parsed.success && isBrowserRoutedEntity(parsed.data) ? (
              <Link
                to={entities[parsed.data].routes.detail}
                params={entityDetailParams(crumb.id)}
                className="hover:text-foreground"
              >
                {crumb.name}
              </Link>
            ) : (
              <span>{crumb.name}</span>
            )}
          </span>
        );
      })}
      {heroNo && (
        <span className="inline-flex items-center gap-x-1 max-md:hidden">
          <Separator />
          <CopyableShortcode
            code={heroNo}
            className="min-h-11 font-mono text-muted-foreground md:min-h-0"
          />
        </span>
      )}
    </nav>
  );
}

interface DetailPageHeaderProps {
  entity: Entity;
  wayfinding?: DetailWayfinding | false;
  title: ReactNode;
  /** Raw record used for the declared `hero.when` and added-date facts. */
  rawData?: unknown;
  /** Reference code shown in the breadcrumb (e.g. the product shortcode). */
  heroNo?: string;
  /** Record status beside the title. */
  heroStamp?: { label: string; tone?: "ink" | "red" | "green" };
  /** Ordered detail cells under the identity. */
  summary?: ReactNode;
  heroActions?: DetailHeroActions;
  /** Identity thumbnail; the full gallery stays in the Images section. */
  heroImages?: Array<{ id: string; url: string; filename: string }>;
  /** Canonical cover when this record has no local gallery image. */
  heroDisplayImage?: ImageUrlSummary | null;
}

/** A record's identity: breadcrumb, title and status, facts, actions, key numbers. */
export function DetailPageHeader({
  entity,
  wayfinding,
  title,
  rawData,
  heroNo,
  heroStamp,
  summary,
  heroActions,
  heroImages,
  heroDisplayImage,
}: DetailPageHeaderProps) {
  const parsedRawData = detailRawDataSchema.safeParse(rawData);
  const createdAt = parsedRawData.success
    ? parsedRawData.data.createdAt
    : undefined;
  const validCreatedAt =
    createdAt !== undefined && !Number.isNaN(new Date(createdAt).getTime());
  const when = parsedRawData.success
    ? entityHeroWhen(entity, parsedRawData.data)
    : null;
  const cover = heroImages?.[0];
  const facts = [
    heroNo && (
      <span key="code" className="md:hidden">
        <CopyableShortcode
          code={heroNo}
          className="min-h-11 font-mono text-foreground md:min-h-0"
        />
      </span>
    ),
    when && (
      <span key="when">
        {when.label} <strong>{when.value}</strong>
      </span>
    ),
    validCreatedAt && (
      <span key="added">
        {when ? "added " : "Added "}
        <DateDisplay timestamp={createdAt} />
      </span>
    ),
  ].filter(Boolean);
  const actions =
    heroActions?.primary || heroActions?.secondary ? (
      <>
        {heroActions.primary}
        {heroActions.secondary}
      </>
    ) : undefined;
  return (
    <PageHeader
      layout="stacked"
      data-testid="detail-spec-plate"
      className={cn(!summary && "border-b border-border pb-3")}
      breadcrumb={
        wayfinding !== false ? (
          <DetailBreadcrumb
            entity={entity}
            heroNo={heroNo}
            wayfinding={wayfinding}
            crumbs={
              (parsedRawData.success && parsedRawData.data.breadcrumb) || []
            }
          />
        ) : undefined
      }
      media={
        heroNo && (cover || heroDisplayImage) ? (
          <ImageChainPopover entity={entity} id={heroNo}>
            <EntityCover
              images={
                heroImages?.length
                  ? heroImages
                  : heroDisplayImage
                    ? [heroDisplayImage]
                    : []
              }
              entity={entity}
              alt="Record cover"
              size={48}
            />
          </ImageChainPopover>
        ) : undefined
      }
      title={title}
      status={
        heroStamp ? (
          <Badge variant={heroStampVariant[heroStamp.tone ?? "ink"]}>
            {heroStamp.label}
          </Badge>
        ) : undefined
      }
      facts={facts}
      actions={actions}
      below={
        summary ? (
          <div className="-mx-2 mt-3 md:-mx-4">{summary}</div>
        ) : undefined
      }
    />
  );
}

interface ListPageHeaderProps {
  title: ReactNode;
  /** The page's parent (domain or owning list), as a breadcrumb leaf. */
  eyebrow?: ReactNode;
  entity?: Entity;
  actions?: ReactNode;
  /**
   * True filtered record count, reported by a list via `usePageCount`.
   * `undefined` renders nothing until the client reports it.
   */
  count?: number;
  /**
   * `workbench`: a durable operating surface whose band hosts the page-level
   * table's query tools (portaled into `data-workbench-*` targets) and stays
   * mounted while the body swaps renderers.
   */
  chrome: "hero" | "workbench";
  /** View/mode control beside the workbench query tools. */
  controls?: ReactNode;
  /** Phone route titles live in the contextual bar unless the page opts in. */
  mobileTitleVisible?: boolean;
}

/** A list or tool page's identity: title with its count, tools and actions. */
export function ListPageHeader({
  title,
  eyebrow,
  entity,
  actions,
  count,
  chrome,
  controls,
  mobileTitleVisible = false,
}: ListPageHeaderProps) {
  // "N products", never "N of M": no unfiltered total is read, so the count
  // always describes the current (possibly filtered) cohort.
  const facts =
    count !== undefined
      ? [
          <span key="count">
            <strong>{formatCount(count)}</strong>
            {entity && isBrowserRoutedEntity(entity)
              ? ` ${entities[entity].pluralLabel.toLocaleLowerCase()}`
              : null}
          </span>,
        ]
      : undefined;
  const breadcrumb = eyebrow != null ? <span>{eyebrow}</span> : undefined;
  if (chrome === "workbench") {
    return (
      <div
        data-workbench-band
        className="border-b border-border bg-card px-2 py-2 max-md:sticky max-md:top-[var(--app-chrome-top)] max-md:z-20 md:px-4"
      >
        <PageHeader
          layout="inline"
          title={title}
          breadcrumb={breadcrumb}
          facts={facts}
          tools={
            // Phone: the view control wraps under the search.
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
              <div
                className="flex min-w-0 flex-1 items-center gap-1.5 max-md:basis-full"
                data-workbench-utilities
              />
              {controls && <div className="shrink-0">{controls}</div>}
            </div>
          }
          actions={
            <div className="flex min-w-0 items-center gap-1.5 overflow-x-auto overscroll-x-contain">
              <div data-workbench-actions className="contents" />
              {actions}
            </div>
          }
          below={
            // The list's saved-view tabs; collapsed when the entity declares none.
            <div
              data-workbench-tabs
              className="-mb-2 flex min-w-0 empty:hidden"
            />
          }
        />
      </div>
    );
  }
  return (
    <PageHeader
      layout="inline"
      title={title}
      breadcrumb={breadcrumb}
      facts={facts}
      actions={actions}
      className={cn(
        "mb-3",
        !mobileTitleVisible && !actions && "max-md:hidden",
        !mobileTitleVisible &&
          "max-md:[&_[data-slot=page-header-identity]]:sr-only",
      )}
    />
  );
}
