import type { RelatedPreviewGroup } from "@cubby/schemas/related-view";
import { EntityIdentityMark } from "~/components/entity/entity-identity-mark";
import { NoneValue } from "~/components/ui/none-value";
import type { EntityDetailRoute } from "~/entities/entities";
import {
  entities,
  entityDetailParams,
  isBrowserRoutedEntity,
} from "~/entities/entities";
import { TableLink } from "../table/TableLink";

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
          {isBrowserRoutedEntity(item.entity) ? (
            <TableLink
              to={entities[item.entity].routes.detail as EntityDetailRoute}
              params={entityDetailParams(item.id)}
              className="max-w-36 truncate"
              variant="muted"
            >
              {item.label}
            </TableLink>
          ) : (
            <span className="max-w-36 truncate text-muted-foreground">
              {item.label}
            </span>
          )}
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
