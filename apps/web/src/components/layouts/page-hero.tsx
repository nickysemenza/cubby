import type { Entity } from "@cubby/schemas/entity";
import { Link, type LinkProps } from "@tanstack/react-router";
import { cva, type VariantProps } from "class-variance-authority";
import {
  Check,
  ClipboardCopy,
  type LucideIcon,
  MoreHorizontal,
} from "lucide-react";
import { type CSSProperties, type ReactNode, useState } from "react";
import { getEntityNavGroup } from "~/app/_components/navigation/nav-items";
import { ImageGallery } from "~/components/media/image-gallery";
import { Button } from "~/components/ui/button";
import { Card, CardContent } from "~/components/ui/card";
import { EYEBROW_CLASS, Eyebrow } from "~/components/ui/eyebrow";
import { InkStamp } from "~/components/ui/ink-stamp";
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "~/components/ui/popover";
import { entities, isBrowserRoutedEntity } from "~/entities/entities";
import { copyShortcodes } from "~/lib/clipboard";
import { HOUSEHOLD_TIMEZONE } from "~/lib/household-date";
import { cn, formatCount } from "~/lib/utils";

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

/** Authored action hierarchy for a detail plate. */
export interface DetailHeroActions {
  /** The single action that should remain visible on every viewport. */
  primary?: ReactNode;
  /** Supporting and destructive actions; collapsed behind Actions on phone. */
  secondary?: ReactNode;
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

/** Pull a created-at date out of the raw entity for the hero's ledger meta. */
export function getOnFileSince(rawData: unknown): string | null {
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
    timeZone: HOUSEHOLD_TIMEZONE,
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
  if (!isBrowserRoutedEntity(entity)) return null;
  const def = entities[entity];
  const group = getEntityNavGroup(entity);

  return (
    <nav
      aria-label="Breadcrumb"
      className={cn(
        EYEBROW_CLASS,
        "hidden flex-wrap items-center gap-x-2 gap-y-1 tracking-[0.14em] md:flex",
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
          <CopyableHeroNo heroNo={heroNo} />
        </>
      )}
    </nav>
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
      No. {heroNo}
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
  meta?: PageHeroMetaItem[];
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

interface ListWorkbenchProps {
  title: ReactNode;
  count?: number;
  controls?: ReactNode;
  actions?: ReactNode;
}

/**
 * Stable first tier for operational lists. The table owns the query/selection
 * tier directly below this; alternate renderers keep this identity tier in the
 * exact same place.
 */
function ListWorkbench({
  title,
  count,
  controls,
  actions,
}: ListWorkbenchProps) {
  return (
    <div className="flex min-h-11 items-center gap-1 border-border border-b bg-card px-2 py-1 sm:gap-2">
      <div className="flex min-w-0 shrink-0 items-baseline gap-2">
        <h1 className="truncate font-bold font-heading text-base tracking-tight max-md:sr-only sm:text-lg">
          {title}
        </h1>
        {count !== undefined && (
          <span className="shrink-0 font-mono text-2xs text-slate uppercase tabular-nums tracking-wider">
            {formatCount(count)}
          </span>
        )}
      </div>
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {controls}
        <div
          className="flex shrink-0 items-center gap-1"
          data-workbench-utilities
        />
      </div>
      {actions && (
        <div className="flex min-w-0 items-center gap-2 overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {actions}
        </div>
      )}
    </div>
  );
}

/**
 * List / compact page header: eyebrow path, big title, optional meta strip and
 * an entity-inked accent bar. The canonical renderer for every non-detail page
 * heading. The unified {@link PageHeader} delegates list rendering here.
 */
function PageHero({
  title,
  eyebrow,
  meta,
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
  const hasPath = eyebrow !== undefined || segments.length > 0;
  const hasCount = count !== undefined;
  // Only a plain-string title reads sensibly appended after the number
  // ("1,240 Expenses"); non-string titles (rare utility pages) just show
  // the bare count.
  const countLabel =
    hasCount &&
    `${formatCount(count)}${typeof title === "string" ? ` ${title}` : ""}`;
  // Entity-inked accent rule (falls back to ultramarine via the CSS defaults).
  const accent =
    entity && isBrowserRoutedEntity(entity)
      ? entities[entity].color.accent
      : null;
  const accentStyle = accent
    ? ({ "--page-accent": accent } as CSSProperties)
    : undefined;

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
          <h1
            className={cn(
              titleVariants({ variant }),
              mobileTitleVisible && "max-md:text-xl",
            )}
          >
            {title}
          </h1>
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
  heroActions,
  heroImages,
  heroMedia,
}: DetailPlateProps) {
  const onFileSince = getOnFileSince(rawData);

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
        className="border-x-0 border-l-[length:var(--border-spine)] border-l-foreground md:border-r"
        data-testid="detail-spec-plate"
      >
        <CardContent className="px-2 py-1 sm:px-4">
          <div
            className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-x-3 gap-y-1" /* tight */
          >
            <div className="min-w-0">
              <DetailBreadcrumb entity={entity} heroNo={heroNo} />
              <h1 className="break-words font-bold font-heading text-xl leading-6 tracking-tight sm:text-3xl sm:leading-9">
                {name}
              </h1>
            </div>
            <DetailPlateActions actions={heroActions} />
            <div className="col-span-2 flex flex-wrap items-center gap-2 font-mono text-2xs text-muted-foreground uppercase">
              {heroNo && (
                <span className="md:hidden">
                  <CopyableHeroNo heroNo={heroNo} />
                </span>
              )}
              {heroStamp && (
                <InkStamp tone={heroStamp.tone}>{heroStamp.label}</InkStamp>
              )}
              {onFileSince && <span>On file since {onFileSince}</span>}
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

function DetailPlateActions({ actions }: { actions?: DetailHeroActions }) {
  const [menuOpen, setMenuOpen] = useState(false);
  if (!actions?.primary && !actions?.secondary) return null;

  return (
    <div className="flex items-center gap-2 print:hidden">
      {actions.primary}
      {actions.secondary && (
        <>
          <div className="hidden flex-wrap items-center gap-2 md:flex">
            {actions.secondary}
          </div>
          <div className="md:hidden">
            <Popover open={menuOpen} onOpenChange={setMenuOpen}>
              <PopoverTrigger
                render={
                  <Button variant="outline" aria-label="Open detail actions" />
                }
              >
                <MoreHorizontal />
                Actions
              </PopoverTrigger>
              <PopoverContent align="end" className="w-56">
                <PopoverTitle className="font-mono text-2xs text-slate uppercase tracking-wider">
                  Record actions
                </PopoverTitle>
                <fieldset
                  className="flex flex-col gap-1 [&_[data-slot=button]]:w-full [&_[data-slot=button]]:justify-start"
                  onClickCapture={() => setMenuOpen(false)}
                >
                  <legend className="sr-only">Record actions</legend>
                  {actions.secondary}
                </fieldset>
              </PopoverContent>
            </Popover>
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
    return (
      <ListWorkbench
        title={title}
        count={count}
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
