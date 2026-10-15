import type { Entity } from "@cubby/schemas/entity";
import type { RelatedPreviewGroup } from "@cubby/schemas/related-view";
import { Link } from "@tanstack/react-router";

import { EntityIdentityMark } from "~/entity/components/entity-identity-mark";
import { EntityRefLink } from "~/entity/components/entity-ref-link";
import { entityDetailLink, isBrowserRoutedEntity } from "~/entity/entities";
import { ChipCluster } from "~/ui/common/chip-cluster";
import { NoneValue } from "~/ui/primitives/none-value";

function RelatedEntityLink({
  item,
  className,
}: {
  item: RelatedPreviewGroup["items"][number];
  className: string;
}) {
  if (item.entity === "usda-food") {
    return (
      <EntityRefLink
        variant="table"
        to="/usda/$id"
        params={{ id: item.id }}
        className={className}
        tone="muted"
      >
        {item.label}
      </EntityRefLink>
    );
  }
  if (!isBrowserRoutedEntity(item.entity)) {
    return (
      <span className={`${className} text-muted-foreground`}>{item.label}</span>
    );
  }
  const link = entityDetailLink(item.entity, item.id);
  return (
    <EntityRefLink
      variant="table"
      to={link.to}
      params={link.params}
      className={className}
      tone="muted"
    >
      {item.label}
    </EntityRefLink>
  );
}

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
          <span className="flex h-3 min-w-0 items-center gap-0.5 text-xs leading-3">
            <EntityIdentityMark
              entity={item.entity}
              displayImage={item.displayImage}
              className="size-3!"
            />
            <RelatedEntityLink item={item} className="min-w-0 truncate" />
          </span>
        ),
      }))}
    />
  );
}
