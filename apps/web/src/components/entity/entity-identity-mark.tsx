import type { Entity } from "@cubby/schemas/entity";
import type { ImageUrlSummary } from "@cubby/schemas/image-summary";
import type { ReactNode } from "react";

import { EntityCover } from "~/components/entity/entity-cover";
import { EntityIcon } from "~/entities/entities";
import { cn } from "~/lib/utils";

export type EntityIdentityMarkSize = "inline" | "row" | "card";

const MARK_SIZE = {
  inline: 16,
  row: 24,
  card: 40,
} as const satisfies Record<EntityIdentityMarkSize, number>;

const containedEntities = new Set<Entity>(["product", "vendor", "cookbook"]);

/**
 * Progressive image-or-icon identity shared by entity record links.
 *
 * The box is stable before image data arrives, while the image downloads, and
 * after a failure. Text therefore never shifts when a cover replaces its mark.
 */
export function EntityIdentityMark({
  entity,
  displayImage,
  size = "inline",
  fallback,
  className,
}: {
  entity: Entity;
  displayImage: ImageUrlSummary | null;
  size?: EntityIdentityMarkSize;
  fallback?: ReactNode;
  className?: string;
}) {
  const pixels = MARK_SIZE[size];
  const fallbackMark = fallback ?? (
    <EntityIcon entity={entity} colored size={size === "inline" ? 12 : 16} />
  );

  if (!displayImage) {
    return (
      <span
        aria-hidden
        className={cn("flex shrink-0 items-center justify-center", className)}
        style={{ width: pixels, height: pixels }}
      >
        {fallbackMark}
      </span>
    );
  }

  return (
    <EntityCover
      images={[
        {
          id: `${entity}:${displayImage.url}`,
          url: displayImage.url,
          representations: displayImage.representations,
        },
      ]}
      entity={entity}
      alt=""
      size={pixels}
      fit={containedEntities.has(entity) ? "contain" : "cover"}
      fallback={
        <span className="flex h-full w-full items-center justify-center bg-card">
          {fallbackMark}
        </span>
      }
      className={cn("border border-border bg-card", className)}
    />
  );
}
