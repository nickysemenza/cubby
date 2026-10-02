import { recordEmojiInput } from "@cubby/schemas/emoji";
import type { Entity } from "@cubby/schemas/entity";

import { EntityIcon } from "~/entity/entities";
import { cn } from "~/lib/utils";

/** All record marks share a fixed footprint and a declaration-owned type fallback. */
export function RecordEmoji({
  entity,
  emoji,
  size = 14,
  className,
}: {
  entity: Entity;
  emoji?: string | null;
  size?: number;
  className?: string;
}) {
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
      entity={entity}
      size={size}
      colored
      aria-hidden="true"
      className={className}
    />
  );
}
