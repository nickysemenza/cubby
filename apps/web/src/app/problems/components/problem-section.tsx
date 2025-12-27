"use client";

import { ExternalLink, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { EntityPreviewCard } from "~/components/entity/entity-preview-card";
import { Badge } from "~/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";

interface ProblemSectionProps<T> {
  title: string;
  description: string;
  icon: LucideIcon;
  iconColor: string;
  items: T[];
  emptyMessage: string;
  renderItem: (item: T) => {
    title: string;
    subtitle?: string;
    badges?: ReactNode[];
    details?: ReactNode[];
    editUrl: string;
    editLabel?: string;
    customActions?: ReactNode;
  };
  groupBy?: (items: T[]) => { [key: string]: T[] };
  headerAction?: ReactNode;
}

export function ProblemSection<T>({
  title,
  description,
  icon: Icon,
  iconColor,
  items,
  emptyMessage,
  renderItem,
  groupBy,
  headerAction,
}: ProblemSectionProps<T>) {
  const hasItems = items.length > 0;

  if (!hasItems) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Icon className={`h-5 w-5 ${iconColor}`} />
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
            <Icon className={`h-5 w-5 ${iconColor}`} />
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
              <div className="space-y-3">
                {groupItems.map((item) => {
                  const {
                    title: itemTitle,
                    subtitle,
                    badges = [],
                    details = [],
                    editUrl,
                    editLabel = "Edit",
                    customActions,
                  } = renderItem(item);

                  return (
                    <EntityPreviewCard
                      key={`${itemTitle}-${editUrl}`}
                      title={itemTitle}
                      subtitle={subtitle}
                      badges={badges}
                      details={details}
                      primaryAction={{
                        href: editUrl,
                        label: editLabel,
                        icon: ExternalLink,
                      }}
                      secondaryActions={customActions}
                    />
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
