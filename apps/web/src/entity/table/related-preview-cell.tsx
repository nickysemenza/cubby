import type { Entity } from "@cubby/schemas/entity";
import type { RelatedPreviewGroup } from "@cubby/schemas/related-view";
import { Link } from "@tanstack/react-router";

import { EntityRefLink } from "~/entity/components/entity-ref-link";
import { ChipCluster } from "~/ui/records/chip-cluster";
import { NoneValue } from "~/ui/text/none-value";

const viewAllClass =
  "text-xs text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground";

export function RelatedPreviewCell({
  group,
  loading,
  error,
  source,
  relationship,
  listHref,
}: {
  group?: RelatedPreviewGroup;
  loading: boolean;
  error?: Error;
  source: Entity;
  relationship?: string;
  /** The target's list filtered to this row; otherwise "View all" opens Connections. */
  listHref?: string;
}) {
  if (loading) {
    return <span className="text-muted-foreground">…</span>;
  }
  if (error) return <span className="text-destructive">{error.message}</span>;
  if (!group || group.totalCount === 0) return <NoneValue />;
  // Wraps to two short lines and counts the rest, like every chip list.
  return (
    <ChipCluster
      more={group.totalCount - group.items.length}
      trailing={
        relationship && listHref ? (
          <a
            href={listHref}
            className={viewAllClass}
            aria-label={`View all ${group.totalCount} related records`}
            onClick={(event) => event.stopPropagation()}
          >
            View all
          </a>
        ) : relationship ? (
          <Link
            to="/connections"
            search={{
              source,
              id: group.sourceId,
              view: `relation:${relationship}`,
            }}
            className={viewAllClass}
            aria-label={`View all ${group.totalCount} related records`}
            onClick={(event) => event.stopPropagation()}
          >
            View all
          </Link>
        ) : undefined
      }
      items={group.items.map((item) => ({
        key: `${item.entity}:${item.id}`,
        label: item.label,
        node: (
          <EntityRefLink
            entity={item.entity}
            id={item.id}
            name={item.label}
            displayImage={item.displayImage}
          />
        ),
      }))}
    />
  );
}
