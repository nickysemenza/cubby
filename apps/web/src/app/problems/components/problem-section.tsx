import { Link } from "@tanstack/react-router";
import { ExternalLink, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
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
import type { Entity } from "~/entities/types";

// Type-safe route patterns
type RoutePattern =
  | { to: "/products/$id"; params: { id: string } }
  | { to: "/locations/$id"; params: { id: string } }
  | { to: "/inventory/$id"; params: { id: string } };

// Icon can be either a LucideIcon component or an entity key
type IconProp =
  | { icon: LucideIcon; entity?: never }
  | { entity: Entity; icon?: never };

type ProblemSectionProps<T> = {
  title: string;
  description: string;
  iconColor: string;
  items: T[];
  emptyMessage: string;
  renderItem: (item: T) => {
    title: string;
    subtitle?: string;
    badges?: ReactNode[];
    details?: ReactNode[];
    route: RoutePattern;
    editLabel?: string;
    customActions?: ReactNode;
  };
  groupBy?: (items: T[]) => { [key: string]: T[] };
  headerAction?: ReactNode;
} & IconProp;

export function ProblemSection<T>({
  title,
  description,
  icon,
  entity,
  iconColor,
  items,
  emptyMessage,
  renderItem,
  groupBy,
  headerAction,
}: ProblemSectionProps<T>) {
  const hasItems = items.length > 0;

  // Render icon based on whether we have an entity or a LucideIcon
  const IconElement = entity ? (
    <EntityIcon entity={entity} className={`h-5 w-5 ${iconColor}`} />
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
          <CardTitle className="flex items-center gap-2">
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
          <CardTitle className="flex items-center gap-2">
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
              <GridContainer cols="cards3" className="stagger-children">
                {groupItems.map((item) => {
                  const {
                    title: itemTitle,
                    subtitle,
                    badges = [],
                    details = [],
                    route,
                    editLabel = "Edit",
                    customActions,
                  } = renderItem(item);

                  return (
                    <MobileCard
                      key={`${itemTitle}-${route.params.id}`}
                      title={itemTitle}
                      subtitle={subtitle}
                      className="border-l border-l-border p-3"
                      actions={
                        <div className="flex gap-1">
                          <Link
                            to={route.to as "/products/$id"}
                            params={route.params as { id: string }}
                          >
                            <Button variant="outline" size="sm">
                              <ExternalLink className="mr-1 h-3 w-3" />
                              {editLabel}
                            </Button>
                          </Link>
                          {customActions}
                        </div>
                      }
                    >
                      {details.length > 0 && (
                        <div className="space-y-0.5">{details}</div>
                      )}
                      {badges.length > 0 && (
                        <div className="flex flex-wrap gap-1">{badges}</div>
                      )}
                    </MobileCard>
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
