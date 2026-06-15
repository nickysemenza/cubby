import type { Entity } from "@cubby/schemas/entity";
import { Link } from "@tanstack/react-router";
import { ExternalLink, type LucideIcon, Wrench, X } from "lucide-react";
import { type ReactNode, useState } from "react";
import { MobileCard } from "~/components/entity/mobile-card";
import { GridContainer } from "~/components/layout/grid-container";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { EntityIcon } from "~/entities/entities";
import type { EntityDetailRoute } from "~/entities/types";

// Type-safe route patterns for entity detail pages
type RoutePattern = { to: EntityDetailRoute; params: { id: string } };

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

type ProblemSectionProps<T> = {
  title: string;
  description: string;
  items: T[];
  emptyMessage: string;
  renderItem: (item: T) => RenderedProblemItem;
  groupBy?: (items: T[]) => { [key: string]: T[] };
  /** Only rendered when items exist */
  headerAction?: ReactNode;
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
}: ProblemSectionProps<T>) {
  const hasItems = items.length > 0;
  const iconColor = hasItems ? "text-destructive" : "text-secondary-foreground";

  // Render icon based on whether we have an entity or a LucideIcon
  const IconElement = entity ? (
    <EntityIcon entity={entity} className={`h-4 w-4 ${iconColor}`} />
  ) : (
    (() => {
      const Icon = icon;
      return <Icon className={`h-5 w-5 ${iconColor}`} />;
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
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>
            {IconElement}
            {title}
            <Badge variant="destructive">{items.length}</Badge>
          </CardTitle>
          {headerAction}
        </div>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-6">
          {Object.entries(groups).map(([groupName, groupItems]) => (
            <div key={groupName}>
              {isGrouped && (
                <h4 className="mb-3 flex items-center gap-2 font-medium">
                  {groupName}
                  <Badge variant="outline">{groupItems.length}</Badge>
                </h4>
              )}
              <GridContainer cols="cards3">
                {groupItems.map((item) => {
                  const rendered = renderItem(item);
                  return (
                    <ProblemCard
                      key={
                        rendered.key ??
                        `${rendered.title}-${rendered.route.params.id}`
                      }
                      rendered={rendered}
                    />
                  );
                })}
              </GridContainer>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
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

  return (
    <MobileCard
      title={title}
      subtitle={subtitle}
      imageSlot={imageSlot}
      className="border-l border-l-border p-3"
      actions={
        <div className="flex gap-1">
          {inlineFix && (
            <Button
              variant={open ? "secondary" : "default"}
              size="sm"
              onClick={() => setOpen((o) => !o)}
            >
              {open ? (
                <X className="mr-1 h-3 w-3" />
              ) : (
                <Wrench className="mr-1 h-3 w-3" />
              )}
              {open ? "Cancel" : inlineFix.label}
            </Button>
          )}
          <Link to={route.to} params={route.params}>
            <Button variant="outline" size="sm">
              <ExternalLink className="mr-1 h-3 w-3" />
              {editLabel}
            </Button>
          </Link>
          {customActions}
        </div>
      }
    >
      {details.length > 0 && <div className="space-y-0.5">{details}</div>}
      {badges.length > 0 && (
        <div className="flex flex-wrap gap-1">{badges}</div>
      )}
      {inlineFix && open && (
        <div className="mt-3 border-t pt-3">
          {inlineFix.render(() => setOpen(false))}
        </div>
      )}
    </MobileCard>
  );
}
