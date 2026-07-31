import type { Entity } from "@cubby/schemas/entity";
import { Link } from "@tanstack/react-router";
import { ExternalLink, type LucideIcon, Wrench, X } from "lucide-react";
import { type ReactNode, useState } from "react";
import { MobileCard } from "~/components/entity/mobile-card";
import { Grid, Stack } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { Progress } from "~/components/ui/progress";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import type {
  EntityDetailParams,
  EntityDetailRoute,
} from "~/entities/entities";
import { EntityIcon } from "~/entities/entities";
import { useRecipeUsage } from "./recipe-usage-context";

// Cap each section's initial render so one noisy detector (e.g. 50+ unit-coverage
// items after an import) can't become an unscrollable wall. A "Show all N"
// expander reveals the rest in place.
const INITIAL_VISIBLE = 12;

// Type-safe route patterns for entity detail pages: either a router-typed
// `to`+`params` pair, or a fully-resolved href for rows a detector has already
// turned into a shortcode-bearing path server-side (e.g. the household-tracker
// rows, whose `href` is built from `row.id` in project/attention.ts).
type RoutePattern =
  | { to: EntityDetailRoute; params: EntityDetailParams }
  | { href: string };

// Pull the entity id back out of a RoutePattern — the default card key and the
// recipe-usage lookup both need it. Every shortcode-bearing detail route is
// keyed `$shortcode` uniformly now (the cookbook `$cookbookId` special case
// died with the uuid routes), so the structured branch is a single field read.
const routeEntityId = (route: RoutePattern): string =>
  "href" in route ? route.href : route.params.shortcode;

// Noun for the "open the full ___" tooltip, keyed by the card's detail route.
const ROUTE_NOUN: Record<string, string> = {
  "/products/$shortcode": "product",
  "/recipes/$shortcode": "recipe",
  "/inventory/$shortcode": "inventory entry",
  "/locations/$shortcode": "location",
  "/purchases/$shortcode": "charge",
  "/vendors/$shortcode": "vendor",
};

// Icon can be either a LucideIcon component or an entity key
export type IconProp =
  | { icon: LucideIcon; entity?: never }
  | { entity: Entity; icon?: never };

/** What a section's `renderItem` returns for a single card. */
export type RenderedProblemItem = {
  /**
   * Stable React key. Defaults to `title`-`route.params.id`, which collides
   * when two cards share both (e.g. the same ingredient name twice in one
   * recipe) — set this to a row-unique id in that case. Also required when
   * `route` is absent, since the fallback has no id to key off of.
   */
  key?: string;
  title: string;
  subtitle?: string;
  badges?: ReactNode[];
  details?: ReactNode[];
  /**
   * Absent for a row whose target no longer exists — an orphaned-embedding
   * row points at an entity that was already deleted, so there is nothing to
   * link to. The card renders unlinked (no "Open" button) rather than a link
   * that 404s.
   */
  route?: RoutePattern;
  editLabel?: string;
  customActions?: ReactNode;
  imageSlot?: ReactNode;
  /**
   * Opt-in inline quick-fix. When set, the card grows a toggle button that
   * expands `render(close)` below the details — resolving the problem without
   * leaving the page. The navigation link stays as an escape hatch. The form
   * owns its own mutation hook (mounted only while open), so `renderItem` stays
   * a pure data function with no hooks.
   */
  inlineFix?: { label: string; render: (close: () => void) => ReactNode };
};

/** A coverage section's denominator — the "M" in "N of M photographed". */
type ProblemSectionMeter = {
  /** Population the remaining items are a fraction of. */
  total: number;
  /** Past-participle for what's been done, e.g. "photographed", "counted". */
  doneLabel: string;
};

/**
 * Present ⇒ this section is backlog, not defects: the rows are things not yet
 * done rather than things that are wrong. See `PROBLEM_CLASS` in
 * @cubby/schemas/problems for which sections are which.
 *
 * Coverage-ness is carried HERE rather than inferred from `meter`, because the
 * two genuinely come apart: `unvalued-buckets` is coverage with no meter (a misc
 * bucket isn't a fraction of anything), and every coverage section is briefly
 * meter-less while its denominators load. Keying the styling off `meter` made
 * both of those render as red defects underneath the "progress, not problems"
 * heading.
 */
export type ProblemSectionCoverage = { meter?: ProblemSectionMeter };

type ProblemSectionProps<T> = {
  title: string;
  description: string;
  items: T[];
  emptyMessage: string;
  renderItem: (item: T) => RenderedProblemItem;
  groupBy?: (items: T[]) => { [key: string]: T[] };
  /** Only rendered when items exist */
  headerAction?: ReactNode;
  coverage?: ProblemSectionCoverage;
} & IconProp;

export function ProblemSection<T>({
  title,
  description,
  icon,
  entity,
  items,
  emptyMessage,
  renderItem,
  groupBy,
  headerAction,
  coverage,
}: ProblemSectionProps<T>) {
  const hasItems = items.length > 0;
  const meter = coverage?.meter;
  // Coverage sections never go red: an un-photographed tool isn't an error, and
  // a permanently-destructive section is exactly what made the old page unreadable.
  const iconColor =
    hasItems && !coverage ? "text-destructive" : "text-secondary-foreground";

  // Render icon based on whether we have an entity or a LucideIcon
  const IconElement = entity ? (
    <EntityIcon entity={entity} className={`size-4 ${iconColor}`} />
  ) : (
    (() => {
      const Icon = icon;
      return <Icon className={`size-5 ${iconColor}`} />;
    })()
  );

  if (!hasItems) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>
            {IconElement}
            {title}
          </CardTitle>
          <CardDescription>{emptyMessage}</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const groups = groupBy ? groupBy(items) : { "": items };
  const isGrouped =
    Object.keys(groups).length > 1 && Object.keys(groups)[0] !== "";

  return (
    // overflow-visible (Card defaults to overflow-hidden for its rounded/image
    // styling) so an expanded inline-fix dropdown — the USDA combobox renders as
    // an absolutely-positioned panel, not a portal — isn't clipped by the card.
    <Card className="overflow-visible">
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>
            {IconElement}
            {title}
            {coverage ? (
              // A coverage section still shows a count when it has no meter —
              // either permanently (unvalued buckets) or until its denominators
              // land — just never in the defect red.
              <Badge variant="secondary">
                {meter
                  ? `${meter.total - items.length} / ${meter.total}`
                  : items.length}
              </Badge>
            ) : (
              <Badge variant="destructive">{items.length}</Badge>
            )}
          </CardTitle>
          {headerAction && (
            <Tooltip>
              <TooltipTrigger render={<span className="contents" />}>
                {headerAction}
              </TooltipTrigger>
              <TooltipContent>
                Fixes all {items.length} detected{" "}
                {items.length === 1 ? "item" : "items"} in this section
              </TooltipContent>
            </Tooltip>
          )}
        </div>
        <CardDescription>{description}</CardDescription>
        {meter && (
          <Stack gap="xs" className="pt-2">
            <Progress value={meter.total - items.length} max={meter.total} />
            <span className="font-mono text-slate text-xs uppercase tracking-wider">
              {meter.total - items.length} of {meter.total} {meter.doneLabel}
              {" · "}
              {items.length} remaining
            </span>
          </Stack>
        )}
      </CardHeader>
      <CardContent>
        <div className="space-y-6">
          {Object.entries(groups).map(([groupName, groupItems]) => (
            <SectionGroup
              key={groupName}
              groupName={isGrouped ? groupName : ""}
              items={groupItems}
              renderItem={renderItem}
            />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * One group within a section — owns its own "show all" cap so a single noisy
 * group can't dominate the page, and each group expands independently.
 */
function SectionGroup<T>({
  groupName,
  items,
  renderItem,
}: {
  groupName: string;
  items: T[];
  renderItem: (item: T) => RenderedProblemItem;
}) {
  const [showAll, setShowAll] = useState(false);
  const hidden = items.length - INITIAL_VISIBLE;
  const visible = showAll ? items : items.slice(0, INITIAL_VISIBLE);

  return (
    <div>
      {groupName && (
        <h4 className="mb-2 flex items-center gap-2 font-medium">
          {groupName}
          <Badge variant="outline">{items.length}</Badge>
        </h4>
      )}
      <Grid cols="cards3">
        {visible.map((item) => {
          const rendered = renderItem(item);
          return (
            <ProblemCard
              key={
                rendered.key ??
                (rendered.route
                  ? `${rendered.title}-${routeEntityId(rendered.route)}`
                  : rendered.title)
              }
              rendered={rendered}
            />
          );
        })}
      </Grid>
      {!showAll && hidden > 0 && (
        <Button
          variant="ghost"
          size="sm"
          className="mt-2"
          onClick={() => setShowAll(true)}
        >
          Show all {items.length}
        </Button>
      )}
    </div>
  );
}

/**
 * One problem card. Holds its own expand state so opening an inline fix on one
 * card doesn't re-render or collapse the others.
 */
function ProblemCard({ rendered }: { rendered: RenderedProblemItem }) {
  const [open, setOpen] = useState(false);
  const {
    title,
    subtitle,
    badges = [],
    details = [],
    route,
    editLabel = "Edit",
    customActions,
    imageSlot,
    inlineFix,
  } = rendered;

  // How many recipes use this product (via its ingredient) — a "how much does
  // fixing this matter" signal. Only set for ingredient-linked products.
  const recipeUsage = useRecipeUsage();
  const recipeCount =
    route && "to" in route && route.to === "/products/$shortcode"
      ? recipeUsage[routeEntityId(route)]
      : undefined;

  return (
    <MobileCard
      title={title}
      subtitle={subtitle}
      imageSlot={imageSlot}
      className="border-l border-l-border p-2"
      actions={
        <div className="flex gap-1">
          {inlineFix && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant={open ? "secondary" : "default"}
                    size="sm"
                    onClick={() => setOpen((o) => !o)}
                  />
                }
              >
                {open ? (
                  <X className="mr-1 size-3" />
                ) : (
                  <Wrench className="mr-1 size-3" />
                )}
                {open ? "Cancel" : inlineFix.label}
              </TooltipTrigger>
              <TooltipContent>Quick fix — just this item</TooltipContent>
            </Tooltip>
          )}
          {route && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="outline"
                    size="sm"
                    render={
                      "href" in route ? (
                        <Link to={route.href} />
                      ) : (
                        <Link to={route.to} params={route.params} />
                      )
                    }
                    nativeButton={false}
                  />
                }
              >
                <ExternalLink className="mr-1 size-3" />
                {editLabel}
              </TooltipTrigger>
              <TooltipContent>
                Open the full{" "}
                {("to" in route ? ROUTE_NOUN[route.to] : undefined) ?? "record"}{" "}
                page
              </TooltipContent>
            </Tooltip>
          )}
          {customActions}
        </div>
      }
    >
      {details.length > 0 && <div className="space-y-1">{details}</div>}
      {badges.length > 0 && (
        <div className="flex flex-wrap gap-1">{badges}</div>
      )}
      {recipeCount !== undefined && (
        <div className="text-muted-foreground text-xs">
          Used in {recipeCount} {recipeCount === 1 ? "recipe" : "recipes"}
        </div>
      )}
      {inlineFix && open && (
        <div className="mt-2 border-t pt-2">
          {inlineFix.render(() => setOpen(false))}
        </div>
      )}
    </MobileCard>
  );
}
