import type { Entity } from "@cubby/schemas/entity";
import type { ImageUrlSummary } from "@cubby/schemas/image-summary";
import { cn } from "cn";
import type { ReactNode } from "react";

import { EntityCover } from "~/entity/components/entity-cover";
import { PersonAvatar } from "~/ui/records/person-avatar";

import { RecordEmoji } from "./record-emoji";

export type EntityIdentityMarkSize =
  | "compact"
  | "inline"
  | "pill"
  | "row"
  | "card";

const MARK_SIZE = {
  compact: 14,
  inline: 16,
  pill: 18,
  row: 24,
  card: 40,
} as const satisfies Record<EntityIdentityMarkSize, number>;

const containedEntities = new Set<Entity>(["product", "vendor", "cookbook"]);

/**
 * Progressive identity shared by entity record links: the record's own emoji,
 * else its image, else its icon.
 *
 * The box is stable before image data arrives, while the image downloads, and
 * after a failure. Text therefore never shifts when a cover replaces its mark.
 */
export function EntityIdentityMark({
  entity,
  displayImage,
  emoji,
  size = "inline",
  fallback,
  id,
  name,
  className,
  preview,
}: {
  entity: Entity;
  id?: string;
  name?: string;
  displayImage: ImageUrlSummary | null;
  emoji?: string | null;
  size?: EntityIdentityMarkSize;
  fallback?: ReactNode;
  className?: string;
  preview?: boolean;
}) {
  const pixels = MARK_SIZE[size];
  // A pill's mark follows the pill's own slot (14px in an 18px desktop pill,
  // 18px on the base scale); a fixed 18px image overflowed the desktop slot.
  const fluid = size === "pill";
  const box = fluid ? undefined : { width: pixels, height: pixels };
  const fallbackMark =
    entity === "ledgerParty" && id && name ? (
      <PersonAvatar
        id={id}
        name={name}
        className={
          size === "compact"
            ? "size-3.5"
            : fluid
              ? "size-(--record-pill-mark)"
              : undefined
        }
      />
    ) : emoji || !fallback ? (
      <RecordEmoji
        entity={entity}
        emoji={emoji}
        size={size === "compact" ? 10 : size === "inline" || fluid ? 12 : 16}
      />
    ) : (
      fallback
    );

  // A chosen emoji replaces any image, own or borrowed.
  if (!displayImage || emoji) {
    return (
      <span
        aria-hidden
        className={cn(
          "flex shrink-0 items-center justify-center",
          fluid && "size-(--record-pill-mark)",
          className,
        )}
        style={box}
      >
        {fallbackMark}
      </span>
    );
  }

  return (
    <EntityCover
      images={[
        {
          url: displayImage.url,
          representations: displayImage.representations,
        },
      ]}
      entity={entity}
      preview={preview}
      alt=""
      size={fluid ? undefined : pixels}
      fit={containedEntities.has(entity) ? "contain" : "cover"}
      fallback={
        <span className="flex h-full w-full items-center justify-center bg-card">
          {fallbackMark}
        </span>
      }
      className={cn(
        "border border-border bg-card",
        fluid && "size-(--record-pill-mark)",
        className,
      )}
    />
  );
}
