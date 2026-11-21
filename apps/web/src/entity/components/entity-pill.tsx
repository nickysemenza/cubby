import type { Entity } from "@cubby/schemas/entity";
import type { ImageUrlSummary } from "@cubby/schemas/image-summary";
import type { ReactNode } from "react";

import { useEntityDisplayImage } from "~/entity/entity-media/entity-display-images";
import {
  RecordPill,
  type RecordPillFact,
  useRecordPillSlots,
} from "~/ui/records/record-pill";

import { EntityIdentityMark } from "./entity-identity-mark";
import { recordTypeCode, titleWithoutQualifier } from "./record-pill-identity";

/**
 * Noninteractive record identity; links and selectable rows own the action.
 * Callers pass what the reference carries and the surrounding
 * `RecordPillHost` picks which slots draw.
 */
export function EntityPill({
  entity,
  id,
  name,
  displayImage,
  emoji,
  fallback,
  parent,
  qualifier,
  fact,
  state,
  replaced,
}: {
  entity: Entity;
  id: string;
  name: string;
  /** Hierarchy ancestors drawn muted after the leaf `name`; always shown. */
  parent?: string | null;
  /** The shared part of `name`: cut from the title and drawn muted after it. */
  qualifier?: string | null;
  fact?: RecordPillFact | null;
  state?: "deleted" | "current";
  /** The merged-away code this reference still holds; `id` is the survivor. */
  replaced?: string | null;
  displayImage: ImageUrlSummary | null;
  emoji?: string | null;
  fallback?: ReactNode;
}) {
  const slots = useRecordPillSlots();
  // An emoji replaces the image, so the pill never joins the image batch.
  const resolvedImage = useEntityDisplayImage(
    { entityKind: entity, entityId: id },
    emoji ? null : (displayImage ?? undefined),
  );
  return (
    <RecordPill
      name={parent ? name : titleWithoutQualifier(name, qualifier ?? null)}
      type={slots.type ? recordTypeCode(entity) : null}
      qualifier={parent ?? (slots.qualifier ? qualifier : null)}
      fact={slots.fact ? fact : null}
      state={state}
      replaced={replaced}
      oneLine={slots.oneLine}
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
