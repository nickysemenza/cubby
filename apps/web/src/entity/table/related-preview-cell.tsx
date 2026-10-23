import type { Entity } from "@cubby/schemas/entity";
import type { RelatedPreviewGroup } from "@cubby/schemas/related-view";
import { Link } from "@tanstack/react-router";

import { EntityRefLink } from "~/entity/components/entity-ref-link";
import { ChipCluster } from "~/ui/common/chip-cluster";
import { NoneValue } from "~/ui/primitives/none-value";

export function RelatedPreviewCell({
  group,
  loading,
  error,
  source,
  relationship,
}: {
  group?: RelatedPreviewGroup;
  loading: boolean;
  error?: Error;
  source: Entity;
  relationship?: string;
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
        relationship ? (
          <Link
            to="/connections"
            search={{
              source,
              id: group.sourceId,
              view: `relation:${relationship}`,
            }}
            className="text-xs text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground"
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
