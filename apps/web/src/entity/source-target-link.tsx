import type { EntitySourceRead } from "@cubby/schemas/entity-source";

import { EntityRefLink } from "~/entity/components/entity-ref-link";
import { isBrowserRoutedEntity } from "~/entity/entities";
import { ExternalLinkText } from "~/ui/ExternalLink";

/** Every citation surface uses the same internal identity or external destination. */
export function SourceTargetLink({
  source,
}: {
  source: Pick<EntitySourceRead, "sourceEntity" | "url">;
}) {
  const target = source.sourceEntity;
  if (target) {
    if (target.deleted || !isBrowserRoutedEntity(target.entityKind))
      return (
        <span>
          {target.name ?? target.entityId}
          {target.deleted ? " (deleted)" : ""}
        </span>
      );
    return (
      <EntityRefLink
        variant="chip"
        entity={target.entityKind}
        id={target.entityId}
        name={target.name}
        wrap
      />
    );
  }
  return source.url ? (
    <ExternalLinkText href={source.url} className="break-all">
      {source.url}
    </ExternalLinkText>
  ) : null;
}
