import type { Entity } from "@cubby/schemas/entity";
import { ArrowSquareOutIcon as ExternalLink } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
import { WrenchIcon as Wrench } from "@phosphor-icons/react/dist/csr/Wrench";
import { XIcon as X } from "@phosphor-icons/react/dist/csr/X";
import type { Icon } from "@phosphor-icons/react/lib";
import { Link } from "@tanstack/react-router";
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
import { cn } from "~/lib/utils";

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

/**
 * Noun for the "open the full ___" tooltip.
 *
 * Keyed by the leading path segment rather than the router pattern, so an
 * `{ href }` card (every household-tracker row builds its path server-side)
 * resolves the same noun as a `{ to, params }` one. The old pattern-keyed map
 * missed href routes entirely and had no entry for expenses, ingredients, meals
 * or cookbooks, so a large share of the page read "open the full record page".
 */
const ROUTE_NOUN = new Map([
  ["products", "product"],
  ["recipes", "recipe"],
  ["inventory", "inventory entry"],
  ["locations", "location"],
  ["purchases", "purchase"],
  ["vendors", "vendor"],
  ["expenses", "expense"],
  ["ingredients", "ingredient"],
  ["projects", "project"],
  ["tasks", "task"],
  ["meals", "meal"],
  ["cookbooks", "cookbook"],
  ["financial", "financial record"],
]);

/** First path segment of either route shape, e.g. `/expenses/EXP-1` → `expenses`. */
const routeNoun = (route: RoutePattern): string => {
  const path = "href" in route ? route.href : route.to;
  return ROUTE_NOUN.get(path.split("/").filter(Boolean)[0] ?? "") ?? "record";
};

// Icon can be either a Icon component or an entity key
export type IconProp =
  | { icon: Icon; entity?: never }
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
  /**
   * Label for the navigation button. Defaults to `Open {noun}` derived from
   * `route`, which is also what the button's tooltip says — so the two cannot
   * disagree, and a new section gets a correct label for free.
   *
   * Only set this to override the noun. It used to default to "Edit", which was
   * wrong twice over: the button navigates rather than edits, and on the cards
   * that carry an inline Delete or Merge the pair read as "Edit / Delete".
   */
  editLabel?: string;
  customActions?: ReactNode;
  imageSlot?: ReactNode;
  /**
   * Severity cue, rendered as the card's left spine.
   *
   * Deliberately a spine rather than a badge: a stamp reading "INFO" on most of
   * a section's cards is a row of chrome that repeats what the group heading
   * already said, and it costs the badge slot that a real measurement wants.
   * Absent keeps the neutral hairline.
   */
  tone?: ProblemTone;
  /**
   * Opt-in inline quick-fix. When set, the card grows a toggle button that
   * expands `render(close)` below the details — resolving the problem without
   * leaving the page. The navigation link stays as an escape hatch. The form
   * owns its own mutation hook (mounted only while open), so `renderItem` stays
   * a pure data function with no hooks.
   */
  inlineFix?: { label: string; render: (close: () => void) => ReactNode };
};

/** How urgently a card wants attention. Mirrors the attention rules' severity. */
type ProblemTone = "critical" | "warning" | "info";

/**
 * Tone → spine class. Static strings, not templated: Tailwind scans source
 * text, so a computed class name would be dropped from the build.
 */
const TONE_SPINE = {
  critical: "border-l-[length:var(--border-spine-card)] border-l-destructive",
  warning: "border-l-[length:var(--border-spine-card)] border-l-warning",
  info: "border-l-[length:var(--border-spine-card)] border-l-slate",
} satisfies Record<ProblemTone, string>;

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
  /**
   * How many rows the section really covers, when `items` is only a page of
   * them. Defaults to `items.length`, which is correct for every section that
   * returns its whole population.
   *
   * Load-bearing for view-backed sections: their rows come from page one of an
   * entity list, so every count on this card — the badge, the progress bar, the
   * "N of M · K remaining" line — would otherwise describe the page. With 178
   * never-verified of 212 that reads "200 of 212 verified · 12 remaining"
   * instead of "34 of 212 · 178 remaining", which is the same lie the sampling
   * was introduced to avoid telling at the badge.
   */
  count?: number;
  emptyMessage: string;
  renderItem: (item: T) => RenderedProblemItem;
  groupBy?: (items: T[]) => { [key: string]: T[] };
  /** Only rendered when items exist */
  headerAction?: ReactNode;
  /** Read-only explanation of the canonical Problem query. */
  assembly?: ReactNode;
  coverage?: ProblemSectionCoverage;
  /**
   * Render nothing at all — not even the empty-state card — when this section
   * has no items. For a regression guard (referential liveness, dependency
   * cycles) a healthy zero is the overwhelmingly common case, and a
   * permanent empty card for a check nobody needs to see is exactly the kind
   * of always-there chrome that trained everyone to stop reading the page.
   */
  hideWhenEmpty?: boolean;
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
  assembly,
  coverage,
  count,
  hideWhenEmpty,
}: ProblemSectionProps<T>) {
  const hasItems = items.length > 0;
  const meter = coverage?.meter;
  // Every COUNT below is about the population; `items` is only what we render.
  const total = count ?? items.length;
  // Coverage sections never go red: an un-photographed tool isn't an error, and
  // a permanently-destructive section is exactly what made the old page unreadable.
  const iconColor =
    hasItems && !coverage ? "text-destructive" : "text-secondary-foreground";

  const IconElement = entity ? (
    <EntityIcon entity={entity} className={`size-4 ${iconColor}`} />
  ) : (
    (() => {
      const Icon = icon;
      return <Icon className={`size-5 ${iconColor}`} />;
    })()
  );

  if (!hasItems) {
    if (hideWhenEmpty) return null;
    return (
      <Card>
        <CardHeader>
          <CardTitle>
            {IconElement}
            {title}
          </CardTitle>
          <CardDescription>{emptyMessage}</CardDescription>
          {assembly}
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
                {meter ? `${meter.total - total} / ${meter.total}` : total}
              </Badge>
            ) : (
              <Badge variant="destructive">{total}</Badge>
            )}
          </CardTitle>
          {headerAction && (
            <Tooltip>
              <TooltipTrigger render={<span className="contents" />}>
                {headerAction}
              </TooltipTrigger>
              <TooltipContent>
                Fixes all {total} detected {total === 1 ? "item" : "items"} in
                this section
              </TooltipContent>
            </Tooltip>
          )}
        </div>
        <CardDescription>{description}</CardDescription>
        {assembly}
        {meter && (
          <Stack gap="xs" className="pt-2">
            <Progress value={meter.total - total} max={meter.total} />
            <span className="font-mono text-xs tracking-wider text-slate uppercase">
              {meter.total - total} of {meter.total} {meter.doneLabel}
              {" · "}
              {total} remaining
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
    editLabel,
    customActions,
    imageSlot,
    inlineFix,
    tone,
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
      className={cn(
        "p-2",
        tone ? TONE_SPINE[tone] : "border-l border-l-border",
      )}
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
                {editLabel ?? `Open ${routeNoun(route)}`}
              </TooltipTrigger>
              <TooltipContent>
                Open the full {routeNoun(route)} page
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
        <div className="text-xs text-muted-foreground">
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
