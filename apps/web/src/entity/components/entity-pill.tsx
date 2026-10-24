import type { Entity } from "@cubby/schemas/entity";
import type { ImageUrlSummary } from "@cubby/schemas/image-summary";
import type { ReactNode } from "react";

import { useEntityDisplayImage } from "~/entity/entity-media/entity-display-images";
import { RecordPill } from "~/ui/common/record-pill";

import { EntityIdentityMark } from "./entity-identity-mark";

/** Noninteractive record identity; links and selectable rows own the action. */
export function EntityPill({
  entity,
  id,
  name,
  displayImage,
  emoji,
  fallback,
}: {
  entity: Entity;
  id: string;
  name: string;
  displayImage: ImageUrlSummary | null;
  emoji?: string | null;
  fallback?: ReactNode;
}) {
  const resolvedImage = useEntityDisplayImage({
    entityKind: entity,
    entityId: id,
  });
  return (
    <RecordPill
      name={name}
      mark={
        <EntityIdentityMark
          entity={entity}
          id={id}
          name={name}
          displayImage={displayImage ?? resolvedImage}
          emoji={emoji}
          fallback={fallback}
          size="pill"
        />
      }
    />
  );
}
