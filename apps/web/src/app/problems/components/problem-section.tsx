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

// Type-safe route patterns for entity detail pages
type RoutePattern = { to: EntityDetailRoute; params: EntityDetailParams };

// Detail-route params are `$id` everywhere except cookbook (`$cookbookId`), so
// pulling the entity id back out of a RoutePattern needs both shapes.
const routeEntityId = (route: RoutePattern): string =>
  "id" in route.params ? route.params.id : route.params.cookbookId;

// Noun for the "open the full ___" tooltip, keyed by the card's detail route.
const ROUTE_NOUN: Record<string, string> = {
  "/products/$id": "product",
  "/recipes/$id": "recipe",
  "/inventory/$id": "inventory entry",
  "/locations/$id": "location",
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
   * recipe) — set this to a row-unique id in that case.
   */
  key?: string;
  title: string;
  subtitle?: string;
  badges?: ReactNode[];
  details?: ReactNode[];
  route: RoutePattern;
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

/**
 * A coverage section's denominator. Present ⇒ this section is backlog, not
 * defects: the rows are things not yet done rather than things that are wrong,
 * so it renders a neutral "N of M" meter instead of a red count. See
 * `PROBLEM_CLASS` in @cubby/schemas/problems for which sections are which.
 */
export type ProblemSectionMeter = {
  /** Population the remaining items are a fraction of. */
  total: number;
  /** Past-participle for what's been done, e.g. "photographed", "counted". */
  doneLabel: string;
};

type ProblemSectionProps<T> = {
  title: string;
  description: string;
  items: T[];
  emptyMessage: string;
  renderItem: (item: T) => RenderedProblemItem;
  groupBy?: (items: T[]) => { [key: string]: T[] };
  /** Only rendered when items exist */
  headerAction?: ReactNode;
  meter?: ProblemSectionMeter;
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
  meter,
}: ProblemSectionProps<T>) {
  const hasItems = items.length > 0;
  // Coverage sections never go red: an un-photographed tool isn't an error, and
  // a permanently-destructive section is exactly what made the old page unreadable.
  const iconColor =
    hasItems && !meter ? "text-destructive" : "text-secondary-foreground";

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
            {meter ? (
              <Badge variant="secondary">
                {meter.total - items.length} / {meter.total}
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
                `${rendered.title}-${routeEntityId(rendered.route)}`
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
    route.to === "/products/$id"
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
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="outline"
                  size="sm"
                  render={<Link to={route.to} params={route.params} />}
                  nativeButton={false}
                />
              }
            >
              <ExternalLink className="mr-1 size-3" />
              {editLabel}
            </TooltipTrigger>
            <TooltipContent>
              Open the full {ROUTE_NOUN[route.to] ?? "record"} page
            </TooltipContent>
          </Tooltip>
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
