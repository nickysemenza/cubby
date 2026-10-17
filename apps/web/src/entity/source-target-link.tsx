import type { EntitySourceRead } from "@cubby/schemas/entity-source";

import { EntityRefLink } from "~/entity/components/entity-ref-link";
import { isBrowserRoutedEntity } from "~/entity/entities";
import { ExternalLinkText } from "~/ui/external-link";

/** Every citation surface uses the same internal identity and external destination; a Source may carry both. */
export function SourceTargetLink({
  source,
}: {
  source: Pick<EntitySourceRead, "sourceEntity" | "url">;
}) {
  const target = source.sourceEntity;
  const record = !target ? null : target.deleted ||
    !isBrowserRoutedEntity(target.entityKind) ? (
    <span>
      {target.name ?? target.entityId}
      {target.deleted ? " (deleted)" : ""}
    </span>
  ) : (
    <EntityRefLink
      variant="chip"
      entity={target.entityKind}
      id={target.entityId}
      name={target.name}
      wrap
    />
  );
  const page = source.url ? (
    <ExternalLinkText href={source.url} className="break-all">
      {source.url}
    </ExternalLinkText>
  ) : null;
  if (record && page)
    return (
      <span className="inline-flex flex-wrap items-center gap-x-2">
        {record}
        {page}
      </span>
    );
  return record ?? page;
}
