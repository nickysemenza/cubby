import type { Entity } from "@cubby/schemas/entity";
import { Link, type LinkProps } from "@tanstack/react-router";
import { cva, type VariantProps } from "class-variance-authority";
import type { LucideIcon } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { getEntityNavGroup } from "~/app/_components/navigation/nav-items";
import { ImageGallery } from "~/components/media/image-gallery";
import { Card, CardContent } from "~/components/ui/card";
import { EYEBROW_CLASS, Eyebrow } from "~/components/ui/eyebrow";
import { InkStamp } from "~/components/ui/ink-stamp";
import { entities } from "~/entities/entities";
import { ENTITY_ACCENTS } from "~/entities/entity-accents";
import { cn } from "~/lib/utils";

/** `Intl.NumberFormat` is expensive to construct — one shared instance for
 * every list-page eyebrow's record count ("1,240"). */
const RECORD_COUNT_FORMATTER = new Intl.NumberFormat("en-US");

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

const titleVariants = cva("break-words font-heading tracking-tight", {
  variants: {
    variant: {
      // Both steps use the compact text-2xl heading; the list variant keeps its
      // identity from the accent bar under the title, not a larger type size.
      list: "font-bold text-2xl",
      compact: "font-bold text-2xl",
    },
  },
  defaultVariants: { variant: "list" },
});

interface PageHeroMetaItem {
  icon?: LucideIcon;
  label: ReactNode;
}

/** Inline ledger stat on the detail spec-plate hero (on hand, value, ...). */
export interface DetailHeroStat {
  label: string;
  value: ReactNode;
}

/** One eyebrow path segment. `to` is set only for the leading nav-group
 * segment, and only when {@link getEntityNavGroup} resolves a group with an
 * actual landing route — most groups are dropdown-only and stay plain text. */
interface EyebrowSegment {
  label: string;
  to?: LinkProps["to"];
}

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

/** Pull a created-at date out of the raw entity for the hero's ledger meta. */
function getOnFileSince(rawData: unknown): string | null {
  if (typeof rawData !== "object" || rawData === null) return null;
  const createdAt = (rawData as { createdAt?: unknown }).createdAt;
  if (typeof createdAt !== "string" && !(createdAt instanceof Date)) {
    return null;
  }
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString("en-US", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

/**
 * Ledger breadcrumb trail for a detail header, e.g. `Pantry / Products / No. SKU1`.
 * Mono/eyebrow styled with hairline separators. The entity's plural label is
 * always a real `<Link>` back to its list; an optional `No. X` reference code is
 * appended as the (unlinked) current leaf. When there's no `heroNo`, the linked
 * plural label is itself the last segment (the big title below is the record).
 */
function DetailBreadcrumb({
  entity,
  heroNo,
}: {
  entity: Entity;
  heroNo?: string;
}) {
  const def = entities[entity];
  const group = getEntityNavGroup(entity);

  return (
    <nav
      aria-label="Breadcrumb"
      className={cn(
        EYEBROW_CLASS,
        "flex flex-wrap items-center gap-x-2 gap-y-1 tracking-[0.14em]",
      )}
    >
      {group && (
        <>
          <span className="text-muted-foreground">{group.label}</span>
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
        <>
          <EyebrowSeparator />
          <span className="text-foreground">No. {heroNo}</span>
        </>
      )}
    </nav>
  );
}

interface PageHeroProps extends VariantProps<typeof heroVariants> {
  title: ReactNode;
  /** Small uppercase label above the title (e.g. "Pantry" above "Locations"). */
  eyebrow?: ReactNode;
  /** Bullet-separated meta items below the title. Detail/compact variants render with icons inline. */
  meta?: PageHeroMetaItem[];
  /** Right-aligned action area (typically buttons). */
  actions?: ReactNode;
  /** Optional entity used for derived eyebrow text and accent color. */
  entity?: Entity;
  /** Decoration under title. "accent" applies the ultramarine page-header-accent rule. */
  decoration?: "accent" | "none";
  className?: string;
  /**
   * True filtered record count, reported by a list via `usePageCount`.
   * Rendered at the tail of the eyebrow line as e.g. "1,240 EXPENSES" (the
   * string `title` uppercased by the eyebrow's own CSS). `undefined` renders
   * nothing — avoids a flash of "0" before the client-side report lands.
   */
  count?: number;
}

/**
 * List / compact page header: eyebrow path, big title, optional meta strip and
 * an entity-inked accent bar. The canonical renderer for every non-detail page
 * heading. The unified {@link PageHeader} delegates list rendering here.
 */
export function PageHero({
  title,
  eyebrow,
  meta,
  actions,
  entity,
  variant = "list",
  decoration = "accent",
  className,
  count,
}: PageHeroProps) {
  const showAccent = decoration === "accent" && variant !== "compact";
  // A caller-supplied `eyebrow` overrides the derived path outright (no
  // group-linking — it's not necessarily entity-shaped). Otherwise derive
  // segments from the entity so the leading group can link out.
  const segments =
    eyebrow === undefined && entity ? deriveEyebrowSegments(entity, title) : [];
  const hasPath = eyebrow !== undefined || segments.length > 0;
  const hasCount = count !== undefined;
  // Only a plain-string title reads sensibly appended after the number
  // ("1,240 Expenses"); non-string titles (rare utility pages) just show
  // the bare count.
  const countLabel =
    hasCount &&
    `${RECORD_COUNT_FORMATTER.format(count)}${typeof title === "string" ? ` ${title}` : ""}`;
  // Entity-inked accent rule (falls back to ultramarine via the CSS defaults).
  const accent = entity ? ENTITY_ACCENTS[entity] : null;
  const accentStyle = accent
    ? ({ "--page-accent": accent } as CSSProperties)
    : undefined;

  return (
    <div
      className={cn(heroVariants({ variant }), className)}
      style={accentStyle}
    >
      <div className="min-w-0 flex-1">
        {(hasPath || hasCount) && (
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
        )}
        <div
          className={cn(
            "flex items-center gap-2",
            showAccent && "page-header-accent pb-2",
          )}
        >
          <h1 className={titleVariants({ variant })}>{title}</h1>
        </div>
        {meta && meta.length > 0 && (
          <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-2xs text-muted-foreground">
            {meta.map((item, i) => (
              <span
                // biome-ignore lint/suspicious/noArrayIndexKey: meta items are positional and have no stable id
                key={i}
                className="inline-flex items-center gap-1.5" /* tight */
              >
                {item.icon && <item.icon className="size-3 shrink-0" />}
                <span>{item.label}</span>
              </span>
            ))}
          </div>
        )}
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
  /** Raw entity used for the "On file since" ledger line. */
  rawData?: unknown;
  /** Reference code shown in the eyebrow (e.g. the product shortcode). */
  heroNo?: string;
  /** Status stamp on the plate (e.g. IN STOCK). */
  heroStamp?: { label: string; tone?: "ink" | "red" | "green" };
  /** Inline ledger stats strip (on hand, value, ...). */
  heroStats?: DetailHeroStat[];
  /** Page-level action cluster (edit / move / delete) rendered on the plate. */
  actions?: ReactNode;
  /** Images shown as a swipeable hero gallery on mobile (above the plate). */
  heroImages?: Array<{ id: string; url: string; filename: string }>;
}

/**
 * Detail spec-plate hero: a flat ledger placard with an ink left spine, a
 * "pluralLabel / No. X" eyebrow, the big name, an "On file since" line, a
 * status stamp, an inline ledger stat strip, and the page action cluster.
 *
 * Warm-Paper Ledger: the spine is a square ink rule (not an entity hue) —
 * separation is by rule and tone, and the lone ultramarine is reserved for the
 * live status stamp / value. The mobile image gallery rides above the plate
 * when heroImages are present.
 */
function DetailPlate({
  entity,
  name,
  rawData,
  heroNo,
  heroStamp,
  heroStats,
  actions,
  heroImages,
}: DetailPlateProps) {
  const onFileSince = getOnFileSince(rawData);

  return (
    <>
      {/* Hero image gallery — mobile only; desktop shows it in section col-2. */}
      {heroImages && heroImages.length > 0 && (
        <div className="-mx-4 -mt-4 md:hidden">
          <ImageGallery images={heroImages} />
        </div>
      )}

      <Card
        className="border-l-[length:var(--border-spine)] border-l-foreground"
        data-testid="detail-spec-plate"
      >
        <CardContent className="px-4 py-1 sm:px-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
            <div className="min-w-0">
              <DetailBreadcrumb entity={entity} heroNo={heroNo} />
              <h1 className="break-words font-bold font-heading text-2xl tracking-tight sm:text-3xl">
                {name}
              </h1>
              {onFileSince && (
                <p className="mt-1 font-mono text-2xs text-muted-foreground uppercase">
                  On file since {onFileSince}
                </p>
              )}
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2 sm:shrink-0">
              {heroStamp && (
                <InkStamp tone={heroStamp.tone} className="mt-1">
                  {heroStamp.label}
                </InkStamp>
              )}
              {actions}
            </div>
          </div>
          {heroStats && heroStats.length > 0 && (
            // Flat ledger stat strip — crisp hairline rules (no dashed warmth),
            // square cells, mono tabular numerals.
            <div className="mt-4 flex border-border border-t pt-2">
              {heroStats.map((stat, i) => (
                <div
                  key={stat.label}
                  className={cn(
                    "min-w-0 flex-1",
                    i > 0 && "border-border border-l pl-4",
                  )}
                >
                  <Eyebrow as="div">{stat.label}</Eyebrow>
                  <div className="truncate font-mono font-semibold text-base tabular-nums">
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

interface PageHeaderProps {
  /** "list" renders the eyebrow/title/accent header; "detail" the spec-plate. */
  variant: "list" | "detail";
  title: ReactNode;
  eyebrow?: ReactNode;
  entity?: Entity;
  actions?: ReactNode;
  className?: string;
  /** List-only: smaller title for utility pages (maps to PageHero "compact"). */
  compact?: boolean;
  /** List-only: "none" drops the accent bar under the title. */
  decoration?: "accent" | "none";
  // Detail-only spec-plate extras.
  rawData?: unknown;
  heroNo?: string;
  heroStamp?: { label: string; tone?: "ink" | "red" | "green" };
  heroStats?: DetailHeroStat[];
  heroImages?: Array<{ id: string; url: string; filename: string }>;
  /** List-only: true filtered record count (see {@link PageHeroProps.count}). */
  count?: number;
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
  className,
  compact,
  decoration,
  rawData,
  heroNo,
  heroStamp,
  heroStats,
  heroImages,
  count,
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
        actions={actions}
        heroImages={heroImages}
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
    />
  );
}
