import { recordEmojiInput } from "@cubby/schemas/emoji";
import { entitySchema, type Entity } from "@cubby/schemas/entity";
import type { EntityRosterData } from "@cubby/schemas/entity-metadata-types";
import { entityRoster } from "@cubby/schemas/entity-roster";
import { cn } from "cn";
import { z } from "zod";

import {
  EntityIcon,
  entityIconToneClass,
  isBrowserRoutedEntity,
} from "~/entity/entities";
import { readRecordField } from "~/entity/entity-references";
import { readPathValue } from "~/entity/read-path";
import { OptionGlyph } from "~/ui/media/option-glyph";

const markValue = z.string().nullish();
const markedRecord = z.looseObject({});
type MarkedRecord = z.infer<typeof markedRecord>;

const readMark = (record: MarkedRecord, field: string | null | undefined) => {
  if (!field) return null;
  const value = markValue.safeParse(
    readRecordField(record, field, z.unknown()),
  );
  return value.success && value.data ? value.data : null;
};

/** A record's own emoji, from its field envelope or a flat read. */
export const recordEmojiOf = (entity: Entity, record: unknown) => {
  const row = markedRecord.safeParse(record);
  return row.success
    ? readMark(row.data, entityRoster[entity]?.recordEmojiField)
    : null;
};

/** The declared option glyph standing in for a record without emoji or image. */
export const recordGlyphOf = (entity: Entity, record: unknown) => {
  const row = markedRecord.safeParse(record);
  const glyph: EntityRosterData[Entity]["recordGlyph"] =
    entityRoster[entity]?.recordGlyph ?? null;
  const value = glyph && row.success ? readMark(row.data, glyph.field) : null;
  return (value && glyph?.glyphs[value]?.phosphor) ?? null;
};

/**
 * All record marks share a fixed footprint. The record's emoji wins; then a
 * declared option glyph (a product category's family); then the type glyph,
 * or the entity named by `recordIconEntityField`.
 */
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
  const iconField = entityRoster[entity]?.recordIconEntityField;
  const icon = entitySchema.safeParse(
    iconField ? readPathValue(record, iconField) : null,
  );
  const legacy = Boolean(emoji && !recordEmojiInput.safeParse(emoji).success);
  const glyph = emoji ? null : recordGlyphOf(entity, record);
  if (emoji)
    return (
      <span
        aria-hidden="true"
        className={cn(
          "inline-flex shrink-0 items-center justify-center leading-none",
          className,
        )}
        style={{
          width: legacy ? undefined : size,
          height: size,
          fontSize: size,
        }}
      >
        {emoji}
      </span>
    );
  if (glyph)
    return (
      <span
        aria-hidden="true"
        className={cn(
          "inline-flex shrink-0 items-center justify-center",
          isBrowserRoutedEntity(entity) && entityIconToneClass(entity),
          className,
        )}
        style={{ width: size, height: size }}
      >
        <OptionGlyph name={glyph} weight="regular" className="size-full" />
      </span>
    );
  return (
    <EntityIcon
      entity={icon.success ? icon.data : entity}
      size={size}
      aria-hidden="true"
      className={className}
    />
  );
}
