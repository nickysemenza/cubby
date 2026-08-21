import type { AuditEntityType } from "@cubby/schemas/audit";
import type { ImageUrlSummary } from "@cubby/schemas/image-summary";
import { Link } from "@tanstack/react-router";
import { EntityIdentityMark } from "~/components/entity/entity-identity-mark";
import { entities, entityDetailParams } from "~/entities/entities";
import { cn } from "~/lib/utils";

/**
 * Audit rows already carry public shortcodes. Link them directly instead of
 * sending those shortcodes through the legacy UUID-oriented name resolver.
 *
 * The name leads and the code trails as a quiet mono stamp: a feed of rows
 * reading only the entity type and its code told the reader nothing about
 * which thing moved.
 *
 * `name` is optional rather than required because resolution can genuinely
 * come back empty — a purchase whose only name-shaped column is unset, or a
 * row whose name source no longer resolves (an inventory entry is named by a
 * product+location join, so a dangling side leaves nothing to render). The
 * type-plus-code shape survives as that fallback rather than being replaced.
 */
export function AuditEntityLink({
  entityType,
  entityId,
  name,
  displayImage,
  compact,
}: {
  entityType: AuditEntityType;
  entityId: string;
  name?: string | null;
  displayImage: ImageUrlSummary | null;
  compact?: boolean;
}) {
  const entity = entities[entityType];

  return (
    <Link
      to={entity.routes.detail}
      params={entityDetailParams(entityId)}
      className={cn(
        // Fills the ledger row's height on phones so the tap target is the row
        // the reader is aiming at, not the 20px of text inside it.
        "inline-flex min-h-11 min-w-0 items-center gap-2 font-medium text-primary text-sm hover:underline sm:min-h-0",
        // The composite inventory label puts the disambiguating location last,
        // so a cap tuned for the old narrow feed truncated away the very part
        // that identifies the row. Desktop has the room; phones keep the tight
        // cap so the change summary beside it stays visible.
        compact && "max-w-48 sm:max-w-72",
      )}
      title={name ? `${name} · ${entityId}` : `${entity.label} ${entityId}`}
    >
      <EntityIdentityMark entity={entityType} displayImage={displayImage} />
      {name ? (
        <>
          <span className={cn(compact && "truncate")}>{name}</span>
          <span className="shrink-0 font-mono text-2xs text-slate uppercase">
            {entityId}
          </span>
        </>
      ) : (
        <span className={cn(compact && "truncate")}>
          {entity.label} <span className="font-mono text-xs">{entityId}</span>
        </span>
      )}
    </Link>
  );
}
