import type { AuditEntityType } from "@cubby/schemas/audit";
import { Link } from "@tanstack/react-router";
import { EntityIcon, entities, entityDetailParams } from "~/entities/entities";
import { cn } from "~/lib/utils";

/**
 * Audit rows already carry public shortcodes. Link them directly instead of
 * sending those shortcodes through the legacy UUID-oriented name resolver.
 */
export function AuditEntityLink({
  entityType,
  entityId,
  compact,
}: {
  entityType: AuditEntityType;
  entityId: string;
  compact?: boolean;
}) {
  const entity = entities[entityType];

  return (
    <Link
      to={entity.routes.detail}
      params={entityDetailParams(entityId)}
      className={cn(
        "inline-flex min-w-0 items-center gap-2 font-medium text-primary text-sm hover:underline",
        compact && "max-w-48",
      )}
      title={`${entity.label} ${entityId}`}
    >
      <EntityIcon entity={entityType} colored className="size-4 shrink-0" />
      <span className={cn(compact && "truncate")}>
        {entity.label} <span className="font-mono text-xs">{entityId}</span>
      </span>
    </Link>
  );
}
