import type { Entity } from "@cubby/schemas/entity";
import { Link, type LinkProps } from "@tanstack/react-router";
import { cva, type VariantProps } from "class-variance-authority";
import { Check, ClipboardCopy } from "lucide-react";
import { type CSSProperties, type ReactNode, useState } from "react";
import { z } from "zod";

import {
  domainForEntity,
  domainWayfinding,
} from "~/app/_components/navigation/domain-wayfinding";
import { getEntityNavGroup } from "~/app/_components/navigation/nav-items";
import { ImageGallery } from "~/components/media/image-gallery";
import { Badge, type BadgeVariant } from "~/components/ui/badge";
import { Card, CardContent } from "~/components/ui/card";
import { Eyebrow } from "~/components/ui/eyebrow";
import { entities, isBrowserRoutedEntity } from "~/entities/entities";
import { copyShortcodes } from "~/lib/clipboard";
import { HOUSEHOLD_TIMEZONE } from "~/lib/household-date";
import { cn, formatCount } from "~/lib/utils";

import { WorkbenchBand } from "./workbench-band";

const heroVariants = cva(
  "flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-start sm:justify-between",
  {
    variants: {
      variant: {
        // List identity is the eyebrow/count/accent bar, not whitespace — the
        // hero sits tight so the table starts higher (McMaster-Carr density).
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
      // Both steps use the compact text-2xl heading; the list variant keeps its
      // identity from the accent bar under the title, not a larger type size.
      list: "text-2xl font-bold",
      compact: "text-2xl font-bold",
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
   * Supporting and destructive actions, rendered once per width with the
   * overflow treatment that applies there — "inline" at `md+` (every verb
   * spelled out on the plate), "menu" below it (the content renders its own
   * "More actions" popover, see `EntityActionButtons`). The plate never
   * nests a second popover around it.
   */
  secondary?: (overflow: "inline" | "menu") => ReactNode;
}

/** `heroStamp`'s tone, as a `Badge` variant. */
const heroStampVariant = {
  ink: "secondary",
  red: "destructive",
  green: "positive",
} as const satisfies Record<"ink" | "red" | "green", BadgeVariant>;

/** One eyebrow path segment. `to` is set only for the leading nav-group
 * segment, and only when {@link getEntityNavGroup} resolves a group with an
 * actual landing route — most groups are dropdown-only and stay plain text. */
interface EyebrowSegment {
  label: string;
  to?: LinkProps["to"];
}

const detailRawDataSchema = z
  .object({ createdAt: z.union([z.string(), z.date()]).optional() })
  .passthrough();
type DetailRawData = z.infer<typeof detailRawDataSchema>;

const isStringTitle = (value: ReactNode): value is string =>
  typeof value === "string";

/**
 * Derive an eyebrow path from the entity when none is given explicitly.
 * Detail pages get the full path ("Cook / Recipes"); list pages drop the
 * segment that would just repeat the title (so the Recipes list shows "Cook",
 * and a non-grouped entity's list shows nothing). The leading group segment
 * carries a route when the group has a landing page of its own.
 */
function deriveEyebrowSegments(
  entity: Entity,
  title: ReactNode,
): EyebrowSegment[] {
  if (!isBrowserRoutedEntity(entity)) return [];
  const def = entities[entity];
  const group = getEntityNavGroup(entity);
  // The group's own `to` (a landing route, when it has one) rides along with
  // its label — no separate getGroupRoute(label) re-lookup needed.
  const raw: EyebrowSegment[] = group
    ? [{ label: group.label, to: group.to }, { label: def.pluralLabel }]
    : [{ label: def.pluralLabel }];
  return raw.filter((segment) => segment.label !== title);
}

/** Hairline `/` separator shared by the list eyebrow and detail breadcrumb. */
function EyebrowSeparator() {
  return (
    <span aria-hidden className="text-border">
      /
    </span>
  );
}

/**
 * Render a derived eyebrow path's segments, hairline-separated. A segment
 * with a resolved `to` renders as a real `<Link>` (same hover treatment as
 * {@link DetailBreadcrumb}'s linked segment); the rest are plain text — they
 * name the current page, not a navigable ancestor.
 */
function EyebrowPath({ segments }: { segments: EyebrowSegment[] }) {
  return (
    <>
      {segments.map((segment, i) => (
        <span key={segment.label} className="inline-flex items-center gap-x-2">
          {i > 0 && <EyebrowSeparator />}
          {segment.to ? (
            <Link
              to={segment.to}
              className="transition-colors hover:text-foreground"
            >
              {segment.label}
            </Link>
          ) : (
            segment.label
          )}
        </span>
      ))}
    </>
  );
}

/** Pull a created-at date out of the raw entity for the hero's record meta. */
export function getOnFileSince(
  rawData: DetailRawData | undefined,
): string | null {
  const createdAt = rawData?.createdAt;
  if (createdAt === undefined) return null;
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString("en-US", {
    day: "2-digit",
    month: "short",
    timeZone: HOUSEHOLD_TIMEZONE,
    year: "numeric",
  });
}

/**
 * Breadcrumb trail for a detail header, e.g. `Pantry / Products / SKU1` — the
 * mono eyebrow (a data-register label, per DESIGN.md's Label rule, since it
 * ends in the record's code). The leading segment is the entity's domain
 * (falling back to its nav group for an entity with no domain); the plural
 * label is always a real `<Link>` back to its list; an optional reference
 * code is appended as the (unlinked, copyable) current leaf. Shown at every
 * width — the code itself is hidden below `md` since it repeats in the meta
 * row instead.
 */
function DetailBreadcrumb({
  entity,
  heroNo,
}: {
  entity: Entity;
  heroNo?: string;
}) {
  if (!isBrowserRoutedEntity(entity)) return null;
  const def = entities[entity];
  const domain = domainForEntity(entity);
  const leadingLabel = domain
    ? domainWayfinding(domain).label
    : getEntityNavGroup(entity)?.label;

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
 * eyebrow type, and a variant would fight it.
 */
function CopyableHeroNo({ heroNo }: { heroNo: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      title="Copy shortcode"
      className="inline-flex items-center gap-1 text-foreground transition-colors hover:text-primary"
      onClick={async () => {
        if (!(await copyShortcodes([heroNo]))) return;
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {heroNo}
      {copied ? (
        <Check className="size-3" />
      ) : (
        <ClipboardCopy className="size-3 opacity-60" />
      )}
    </button>
  );
}

interface PageHeroProps extends VariantProps<typeof heroVariants> {
  title: ReactNode;
  eyebrow?: ReactNode;
  actions?: ReactNode;
  entity?: Entity;
  decoration?: "accent" | "none";
  className?: string;
  /**
   * True filtered record count, reported by a list via `usePageCount`.
   * Rendered at the tail of the eyebrow line as e.g. "1,240 EXPENSES" (the
   * string `title` uppercased by the eyebrow's own CSS). `undefined` renders
   * nothing — avoids a flash of "0" before the client-side report lands.
   */
  count?: number;
  mobileTitleVisible?: boolean;
}

/**
 * List / compact page header: eyebrow path, big title, optional meta strip and
 * an entity-inked accent bar. The canonical renderer for every non-detail page
 * heading. The unified {@link PageHeader} delegates list rendering here.
 */
function HeroEyebrow({
  eyebrow,
  segments,
  countLabel,
}: {
  eyebrow: ReactNode | undefined;
  segments: ReturnType<typeof deriveEyebrowSegments>;
  countLabel: string | false;
}) {
  const hasPath = eyebrow !== undefined || segments.length > 0;
  if (!hasPath && !countLabel) return null;
  return (
    <Eyebrow className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1 font-medium tracking-[0.18em]">
      {eyebrow ?? <EyebrowPath segments={segments} />}
      {countLabel && (
        <span className="inline-flex items-center gap-x-2">
          {hasPath && (
            <span aria-hidden className="text-border">
              ·
            </span>
          )}
          {countLabel}
        </span>
      )}
    </Eyebrow>
  );
}

function PageHero({
  title,
  eyebrow,
  actions,
  entity,
  variant = "list",
  decoration = "accent",
  className,
  count,
  mobileTitleVisible = false,
}: PageHeroProps) {
  const showAccent = decoration === "accent" && variant !== "compact";
  // A caller-supplied `eyebrow` overrides the derived path outright (no
  // group-linking — it's not necessarily entity-shaped). Otherwise derive
  // segments from the entity so the leading group can link out.
  const segments =
    eyebrow === undefined && entity ? deriveEyebrowSegments(entity, title) : [];
  const hasCount = count !== undefined;
  // Only a plain-string title reads sensibly appended after the number
  // ("1,240 Expenses"); non-string titles (rare utility pages) just show
  // the bare count.
  const countLabel =
    hasCount &&
    `${formatCount(count)}${isStringTitle(title) ? ` ${title}` : ""}`;
  // Route-family wayfinding wins; utility entities keep their own accent.
  const domain = entity ? domainForEntity(entity) : null;
  const accent = domain
    ? `var(${domainWayfinding(domain).accentToken})`
    : entity && isBrowserRoutedEntity(entity)
      ? entities[entity].color.accent
      : null;
  let accentStyle: CSSProperties | undefined;
  if (accent) {
    // SAFETY: React's CSSProperties omits custom-property keys; this value is
    // the literal `--page-accent` string consumed by the hero stylesheet.
    accentStyle = { "--page-accent": accent } as CSSProperties;
  }

  return (
    <div
      className={cn(
        heroVariants({ variant }),
        !mobileTitleVisible && !actions && "max-md:hidden",
        className,
      )}
      style={accentStyle}
    >
      <div
        className={cn(
          "min-w-0 flex-1",
          !mobileTitleVisible && "max-md:sr-only",
        )}
      >
        <HeroEyebrow
          eyebrow={eyebrow}
          segments={segments}
          countLabel={countLabel}
        />
        <div
          className={cn(
            "flex items-center gap-2",
            showAccent && "page-header-accent pb-2",
          )}
        >
          <h1
            className={cn(
              titleVariants({ variant }),
              mobileTitleVisible && "max-md:text-xl",
            )}
          >
            {title}
          </h1>
        </div>
      </div>
      {actions && (
        <div className="flex w-full flex-wrap gap-2 sm:w-auto print:hidden">
          {actions}
        </div>
      )}
    </div>
  );
}

interface DetailPlateProps {
  /** Entity drives the spine color and the pluralLabel eyebrow. */
  entity: Entity;
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
 * Detail record hero: a flat identity surface with a domain left spine,
 * breadcrumb, name, status, added date, compact stats, and page actions.
 *
 * Porcelain Transit: the spine carries route-family wayfinding while status
 * remains a separate semantic signal. The mobile image gallery rides above
 * the plate when heroImages are present.
 */
function DetailPlate({
  entity,
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
  const domain = domainForEntity(entity);
  const domainAccent = domain
    ? `var(${domainWayfinding(domain).accentToken})`
    : undefined;

  return (
    <>
      {/* Detail media — mobile only; desktop shows it in the section rail. */}
      {heroMedia !== undefined ? (
        <div className="relative left-1/2 -mt-2 w-screen max-w-none -translate-x-1/2 overflow-hidden md:hidden">
          {heroMedia}
        </div>
      ) : (
        heroImages &&
        heroImages.length > 0 && (
          <div className="relative left-1/2 -mt-2 w-screen max-w-none -translate-x-1/2 overflow-hidden md:hidden">
            <ImageGallery images={heroImages} />
          </div>
        )
      )}

      <Card
        className="border-x-0 border-l-[length:var(--border-spine-card)] md:border-r"
        style={domainAccent ? { borderLeftColor: domainAccent } : undefined}
        data-testid="detail-spec-plate"
      >
        <CardContent className="px-2 py-1 sm:px-4">
          <div
            className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-x-3 gap-y-1" /* tight */
          >
            <div className="col-span-2 min-w-0 sm:col-span-1">
              <DetailBreadcrumb entity={entity} heroNo={heroNo} />
              <h1 className="font-heading text-xl leading-6 font-bold tracking-tight break-words sm:text-3xl sm:leading-9">
                {name}
              </h1>
            </div>
            <DetailPlateActions actions={heroActions} />
            <div className="col-span-2 flex flex-wrap items-center gap-2 font-mono text-xs text-muted-foreground">
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
            <div className="mt-4 flex border-t border-border pt-2">
              {heroStats.map((stat, i) => (
                <div
                  key={stat.label}
                  className={cn(
                    "min-w-0 flex-1",
                    i > 0 && "border-l border-border pl-4",
                  )}
                >
                  <Eyebrow as="div">{stat.label}</Eyebrow>
                  <div className="truncate font-mono text-base font-semibold tabular-nums">
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
      {secondary && (
        <>
          <div className="hidden flex-wrap items-center gap-2 md:flex">
            {secondary("inline")}
          </div>
          <div className="flex flex-wrap items-center gap-2 md:hidden">
            {secondary("menu")}
          </div>
        </>
      )}
    </div>
  );
}

interface PageHeaderProps {
  variant: "list" | "detail";
  title: ReactNode;
  eyebrow?: ReactNode;
  entity?: Entity;
  actions?: ReactNode;
  heroActions?: DetailHeroActions;
  className?: string;
  compact?: boolean;
  decoration?: "accent" | "none";
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
 * (eyebrow path + big title + accent bar); `variant="detail"` renders the
 * spec-plate placard. Both list and detail page chrome live here so there is one
 * place to evolve the heading system. {@link Page} is the only caller.
 */
export function PageHeader({
  variant,
  title,
  eyebrow,
  entity,
  actions,
  heroActions,
  className,
  compact,
  decoration,
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
    // Same derivation as the hero's own `countLabel` below: only a plain-string
    // title reads sensibly next to the count, lowercased here to match the
    // band's "N products" register.
    const bandCountLabel =
      count !== undefined
        ? `${formatCount(count)}${isStringTitle(title) ? ` ${title.toLocaleLowerCase()}` : ""}`
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
      decoration={decoration}
      className={className}
      count={count}
      mobileTitleVisible={mobileTitleVisible}
    />
  );
}
