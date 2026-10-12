import type { Entity } from "@cubby/schemas/entity";
import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";
import { ClipboardIcon } from "@phosphor-icons/react/dist/csr/Clipboard";
import { Link } from "@tanstack/react-router";
import { cva, type VariantProps } from "class-variance-authority";
import { type ReactNode, useState } from "react";
import { z } from "zod";

import { entities, isBrowserRoutedEntity } from "~/entity/entities";
import { copyShortcodes } from "~/lib/clipboard";
import { formatInstant } from "~/lib/date-format";
import { cn, formatCount } from "~/lib/utils";
import { ImageGallery } from "~/ui/media/image-gallery";
import {
  domainForEntity,
  domainWayfinding,
  type WayfindingDomain,
} from "~/ui/navigation/domain-wayfinding";
import { getEntityNavGroup } from "~/ui/navigation/nav-items";
import { Badge, type BadgeVariant } from "~/ui/primitives/badge";
import { Card, CardContent } from "~/ui/primitives/card";
import { Eyebrow } from "~/ui/primitives/eyebrow";

import { WorkbenchBand } from "./workbench-band";

const heroVariants = cva(
  "flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-start sm:justify-between",
  {
    variants: {
      variant: {
        list: "mb-2",
        compact: "mb-2",
      },
    },
    defaultVariants: { variant: "list" },
  },
);

const titleVariants = cva("font-heading tracking-tight break-words", {
  variants: {
    variant: {
      list: "text-2xl font-semibold",
      compact: "text-2xl font-semibold",
    },
  },
  defaultVariants: { variant: "list" },
});

/** Inline ledger stat on the detail spec-plate hero (on hand, value, ...). */
export interface DetailHeroStat {
  label: string;
  value: ReactNode;
}

/** Authored action hierarchy for a detail plate. */
export interface DetailHeroActions {
  /** The single action that should remain visible on every viewport. */
  primary?: ReactNode;
  /**
   * Supporting and destructive actions. The content owns its width
   * treatment (`EntityActionButtons overflow="responsive"`: every verb
   * spelled out at `md+`, a "More actions" popover below); the plate never
   * nests a second popover around it.
   */
  secondary?: ReactNode;
}

/** `heroStamp`'s tone, as a `Badge` variant. */
const heroStampVariant = {
  ink: "secondary",
  red: "destructive",
  green: "positive",
} as const satisfies Record<"ink" | "red" | "green", BadgeVariant>;

const detailRawDataSchema = z
  .object({ createdAt: z.union([z.string(), z.date()]).optional() })
  .passthrough();
type DetailRawData = z.infer<typeof detailRawDataSchema>;

/** Hairline separator for record navigation. */
function EyebrowSeparator() {
  return (
    <span aria-hidden className="text-muted-foreground">
      /
    </span>
  );
}

/** Pull a created-at date out of the raw entity for the hero's record meta. */
export function getOnFileSince(
  rawData: DetailRawData | undefined,
): string | null {
  const createdAt = rawData?.createdAt;
  if (createdAt === undefined) return null;
  if (Number.isNaN(new Date(createdAt).getTime())) return null;
  return formatInstant(createdAt, "dateShortPadded");
}

/**
 * Breadcrumb trail for a detail header, e.g. `Pantry / Products / SKU1` — the
 * navigation trail. The leading segment is the entity's domain
 * (falling back to its nav group for an entity with no domain); the plural
 * label is always a real `<Link>` back to its list; an optional reference
 * code is appended as the (unlinked, copyable) current leaf. Shown at every
 * width — the code itself is hidden below `md` since it repeats in the meta
 * row instead.
 */
function DetailBreadcrumb({
  entity,
  heroNo,
  wayfinding,
}: {
  entity: Entity;
  heroNo?: string;
  wayfinding?: DetailWayfinding;
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
    <Eyebrow
      as="nav"
      aria-label="Breadcrumb"
      className="flex flex-wrap items-center gap-x-2 gap-y-1"
    >
      {leadingLabel && (
        <>
          <span>{leadingLabel}</span>
          <EyebrowSeparator />
        </>
      )}
      <Link
        to={def.routes.list}
        className={cn(
          "transition-colors hover:text-foreground",
          // The plural label is the leaf when there's no reference no., so it
          // takes the foreground "current" tone; otherwise it's a muted parent.
          heroNo ? "text-muted-foreground" : "text-foreground",
        )}
      >
        {def.pluralLabel}
      </Link>
      {heroNo && (
        <span className="inline-flex items-center gap-x-2 max-md:hidden">
          <EyebrowSeparator />
          <CopyableHeroNo heroNo={heroNo} />
        </span>
      )}
    </Eyebrow>
  );
}

/**
 * The breadcrumb's reference-code leaf, click-to-copy.
 *
 * The shortcode is the id every other surface speaks — MCP payloads, QR labels,
 * URLs — so the one place it's always on screen should hand it over rather than
 * make it retypeable-only. Not a `Button`: it has to keep the breadcrumb's
 * compact navigation type, and a variant would fight it.
 */
function CopyableHeroNo({ heroNo }: { heroNo: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      title="Copy shortcode"
      className="inline-flex min-h-11 items-center gap-1 font-mono text-foreground transition-colors hover:text-primary md:min-h-0"
      onClick={async () => {
        if (!(await copyShortcodes([heroNo]))) return;
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {heroNo}
      {copied ? (
        <CheckIcon className="size-3" />
      ) : (
        <ClipboardIcon className="size-3 opacity-60" />
      )}
    </button>
  );
}

interface PageHeroProps extends VariantProps<typeof heroVariants> {
  title: ReactNode;
  eyebrow?: ReactNode;
  actions?: ReactNode;
  entity?: Entity;
  className?: string;
  /**
   * True filtered record count, reported by a list via `usePageCount`.
   * `undefined` renders nothing until the client reports the filtered count.
   */
  count?: number;
  mobileTitleVisible?: boolean;
}

/**
 * Shared list and specialist heading with inline count and contextual copy.
 */
function PageHero({
  title,
  eyebrow,
  actions,
  variant = "list",
  className,
  count,
  mobileTitleVisible = false,
}: PageHeroProps) {
  return (
    <div
      className={cn(
        heroVariants({ variant }),
        !mobileTitleVisible && !actions && "max-md:hidden",
        className,
      )}
    >
      <div
        className={cn(
          "min-w-0 flex-1",
          !mobileTitleVisible && "max-md:sr-only",
        )}
      >
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1
            className={cn(
              titleVariants({ variant }),
              mobileTitleVisible && "max-md:text-xl",
            )}
          >
            {title}
          </h1>
          {count !== undefined && (
            <span className="text-xs text-muted-foreground tabular-nums">
              {formatCount(count)}
            </span>
          )}
        </div>
        {eyebrow && (
          <div className="mt-1 text-xs text-muted-foreground">{eyebrow}</div>
        )}
      </div>
      {actions && (
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto print:hidden">
          {actions}
        </div>
      )}
    </div>
  );
}

export interface DetailWayfinding {
  label: string;
  domain: WayfindingDomain | null;
}

interface DetailPlateProps {
  /** Entity drives record navigation. */
  entity: Entity;
  wayfinding?: DetailWayfinding;
  /** The big plate title (entity name). */
  name: ReactNode;
  /** Raw entity used for the added-date metadata. */
  rawData?: unknown;
  /** Reference code shown in the breadcrumb (e.g. the product shortcode). */
  heroNo?: string;
  /** Status stamp on the plate (e.g. IN STOCK). */
  heroStamp?: { label: string; tone?: "ink" | "red" | "green" };
  /** Inline record stats strip (on hand, value, ...). */
  heroStats?: DetailHeroStat[];
  /** Deliberate page-level action hierarchy rendered on the plate. */
  heroActions?: DetailHeroActions;
  /** Images shown as a swipeable hero gallery on mobile (above the plate). */
  heroImages?: Array<{ id: string; url: string; filename: string }>;
  /**
   * Sourced detail media shown in place of the owned-image gallery. The slot
   * lets a page present related imagery without treating it as editable record
   * media.
   */
  heroMedia?: ReactNode;
}

/**
 * Detail record hero: a quiet identity surface with a domain breadcrumb,
 * breadcrumb, name, status, added date, compact stats, and page actions.
 *
 * Domain identity and status remain separate semantic signals. The mobile image gallery rides above
 * the plate when heroImages are present.
 */
function DetailPlate({
  entity,
  wayfinding,
  name,
  rawData,
  heroNo,
  heroStamp,
  heroStats,
  heroActions,
  heroImages,
  heroMedia,
}: DetailPlateProps) {
  const parsedRawData = detailRawDataSchema.safeParse(rawData);
  const onFileSince = getOnFileSince(
    parsedRawData.success ? parsedRawData.data : undefined,
  );
  return (
    <>
      {/* Phone media precedes identity; desktop pairs it with the facts rail. */}
      {heroMedia !== undefined ? (
        <div className="mx-auto mb-2 w-full max-w-80 overflow-hidden rounded-xl bg-muted md:hidden">
          {heroMedia}
        </div>
      ) : (
        heroImages &&
        heroImages.length > 0 && (
          <div className="mx-auto mb-2 w-full max-w-80 overflow-hidden rounded-xl bg-muted md:hidden">
            <ImageGallery images={heroImages} />
          </div>
        )
      )}

      <Card className="py-3" data-testid="detail-spec-plate">
        <CardContent className="px-3 py-0 sm:px-4">
          <div
            className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1" /* tight */
          >
            <div className="col-span-2 min-w-0">
              <DetailBreadcrumb
                entity={entity}
                heroNo={heroNo}
                wayfinding={wayfinding}
              />
            </div>
            <h1 className="col-span-2 min-w-0 font-heading text-xl leading-6 font-semibold tracking-tight break-words sm:col-span-1 sm:text-2xl sm:leading-8">
              {name}
            </h1>
            <DetailPlateActions actions={heroActions} />
            <div className="col-span-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              {heroNo && (
                <span className="md:hidden">
                  <CopyableHeroNo heroNo={heroNo} />
                </span>
              )}
              {heroStamp && (
                <Badge variant={heroStampVariant[heroStamp.tone ?? "ink"]}>
                  {heroStamp.label}
                </Badge>
              )}
              {onFileSince && <span>Added {onFileSince}</span>}
            </div>
          </div>
          {heroStats && heroStats.length > 0 && (
            // Compact record stats — hairline separators, plain-language
            // labels, and tabular numerals.
            <div className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs">
              {heroStats.map((stat) => (
                <div
                  key={stat.label}
                  className="flex min-w-0 items-baseline gap-1.5"
                >
                  <span className="text-muted-foreground">{stat.label}</span>
                  <div className="min-w-0 font-semibold tabular-nums">
                    {stat.value}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
}

function DetailPlateActions({ actions }: { actions?: DetailHeroActions }) {
  if (!actions?.primary && !actions?.secondary) return null;
  const secondary = actions.secondary;

  return (
    <div className="col-span-2 flex flex-wrap items-center gap-2 sm:col-span-1 print:hidden">
      {actions.primary}
      {secondary}
    </div>
  );
}

interface PageHeaderProps {
  variant: "list" | "detail";
  title: ReactNode;
  eyebrow?: ReactNode;
  entity?: Entity;
  wayfinding?: DetailWayfinding;
  actions?: ReactNode;
  heroActions?: DetailHeroActions;
  className?: string;
  compact?: boolean;
  // Detail-only spec-plate extras.
  rawData?: unknown;
  heroNo?: string;
  heroStamp?: { label: string; tone?: "ink" | "red" | "green" };
  heroStats?: DetailHeroStat[];
  heroImages?: Array<{ id: string; url: string; filename: string }>;
  heroMedia?: ReactNode;
  count?: number;
  listChrome?: "hero" | "workbench";
  workbenchControls?: ReactNode;
  mobileTitleVisible?: boolean;
}

/**
 * The single unified page header. `variant="list"` delegates to {@link PageHero}
 * (title, count, and actions); `variant="detail"` renders the
 * spec-plate placard. Both list and detail page chrome live here so there is one
 * place to evolve the heading system. {@link Page} is the only caller.
 */
export function PageHeader({
  variant,
  title,
  eyebrow,
  entity,
  wayfinding,
  actions,
  heroActions,
  className,
  compact,
  rawData,
  heroNo,
  heroStamp,
  heroStats,
  heroImages,
  heroMedia,
  count,
  listChrome = "hero",
  workbenchControls,
  mobileTitleVisible,
}: PageHeaderProps) {
  if (variant === "detail") {
    if (!entity) {
      throw new Error('PageHeader variant="detail" requires an entity');
    }
    return (
      <DetailPlate
        entity={entity}
        wayfinding={wayfinding}
        name={title}
        rawData={rawData}
        heroNo={heroNo}
        heroStamp={heroStamp}
        heroStats={heroStats}
        heroActions={heroActions}
        heroImages={heroImages}
        heroMedia={heroMedia}
      />
    );
  }

  if (listChrome === "workbench") {
    const bandCountLabel =
      count !== undefined
        ? `${formatCount(count)}${entity ? ` ${entities[entity].pluralLabel.toLocaleLowerCase()}` : ""}`
        : undefined;
    return (
      <WorkbenchBand
        title={title}
        count={count}
        countLabel={bandCountLabel}
        controls={workbenchControls}
        actions={actions}
      />
    );
  }

  return (
    <PageHero
      variant={compact ? "compact" : "list"}
      title={title}
      eyebrow={eyebrow}
      entity={entity}
      actions={actions}
      className={className}
      count={count}
      mobileTitleVisible={mobileTitleVisible}
    />
  );
}
