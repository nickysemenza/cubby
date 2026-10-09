import { recordEmojiInput } from "@cubby/schemas/emoji";
import { entitySchema, type Entity } from "@cubby/schemas/entity";
import { entityInspectorMetadata } from "@cubby/schemas/entity-manifest";
import { z } from "zod";

import { EntityIcon } from "~/entity/entities";
import { cn } from "~/lib/utils";

/** All record marks share a fixed footprint and a declaration-owned type fallback. */
export function RecordEmoji({
  entity,
  emoji,
  record,
  size = 14,
  className,
}: {
  entity: Entity;
  emoji?: string | null;
  record?: unknown;
  size?: number;
  className?: string;
}) {
  const iconField = entityInspectorMetadata[entity]?.recordIconEntityField;
  const iconData = z.record(z.string(), z.unknown()).catch({}).parse(record);
  const icon = entitySchema.safeParse(iconField ? iconData[iconField] : null);
  const legacy = Boolean(emoji && !recordEmojiInput.safeParse(emoji).success);
  return emoji ? (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex shrink-0 items-center justify-center leading-none",
        className,
      )}
      style={{ width: legacy ? undefined : size, height: size, fontSize: size }}
    >
      {emoji}
    </span>
  ) : (
    <EntityIcon
      entity={icon.success ? icon.data : entity}
      size={size}
      colored
      aria-hidden="true"
      className={className}
    />
  );
}
