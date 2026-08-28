import type { RelatedPreviewGroup } from "@cubby/schemas/related-view";

import { EntityIdentityMark } from "~/components/entity/entity-identity-mark";
import { NoneValue } from "~/components/ui/none-value";
import { entityDetailLink, isBrowserRoutedEntity } from "~/entities/entities";

import { TableLink } from "../table/TableLink";

function RelatedEntityLink({
  item,
  className,
}: {
  item: RelatedPreviewGroup["items"][number];
  className: string;
}) {
  if (item.entity === "usda-food") {
    return (
      <TableLink
        to="/usda/$id"
        params={{ id: item.id }}
        className={className}
        variant="muted"
      >
        {item.label}
      </TableLink>
    );
  }
  if (!isBrowserRoutedEntity(item.entity)) {
    return (
      <span className={`${className} text-muted-foreground`}>{item.label}</span>
    );
  }
  const link = entityDetailLink(item.entity, item.id);
  return (
    <TableLink
      to={link.to}
      params={link.params}
      className={className}
      variant="muted"
    >
      {item.label}
    </TableLink>
  );
}

export function RelatedPreviewCell({
  group,
  loading,
}: {
  group?: RelatedPreviewGroup;
  loading: boolean;
}) {
  if (loading) {
    return <span className="text-muted-foreground">…</span>;
  }
  if (!group || group.totalCount === 0) return <NoneValue />;
  const overflow = group.totalCount - group.items.length;
  return (
    <span className="flex min-w-0 items-center gap-1 overflow-hidden text-sm">
      {group.items.map((item, index) => (
        <span
          key={`${item.entity}:${item.id}`}
          className="flex min-w-0 items-center gap-1"
        >
          {index > 0 && <span className="text-muted-foreground">·</span>}
          <EntityIdentityMark
            entity={item.entity}
            displayImage={item.displayImage}
          />
          <RelatedEntityLink item={item} className="max-w-36 truncate" />
        </span>
      ))}
      {overflow > 0 && (
        <span className="shrink-0 font-mono text-muted-foreground tabular-nums">
          +{overflow}
        </span>
      )}
    </span>
  );
}
