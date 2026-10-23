import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";
import type { problemRowSchema } from "@cubby/schemas/problems";
import type { z } from "zod";

export type ProblemRowInput = z.input<typeof problemRowSchema>;
type BadgeInput = ProblemRowInput["badges"][number];
type Ref = { id: string; name: string };

/** The parser owns both required card fields and selected-list demand. */
export const selectedProblemCard = <S extends z.ZodObject, T, Context>(
  schema: S,
  present: (row: z.output<S>, context: Context) => T,
) => ({
  fields: Object.keys(schema.shape),
  present: (row: unknown, context: Context) =>
    present(schema.parse(row), context),
});

/** A badge naming a record; the page links it to that record. */
export const recordBadge = (entity: ShortcodeEntity, ref: Ref): BadgeInput => ({
  label: ref.name,
  entity,
  id: ref.id,
});

export const locationBadges = (locations: readonly Ref[]): BadgeInput[] =>
  locations.map((location) => recordBadge("location", location));

type FieldInput = ProblemRowInput["fields"][number];

/** A labelled fact; `tone` marks a value that is itself the defect. */
export const field = (
  label: string,
  value: string,
  tone: FieldInput["tone"] = null,
): FieldInput => ({ label, value, tone });

/** The uniform Problems row; falsy fields are dropped. */
export const problemRow = (
  entity: ShortcodeEntity,
  ref: Ref,
  fields: readonly (FieldInput | null | undefined | false)[],
  badges: BadgeInput[] = [],
): ProblemRowInput => ({
  entity,
  id: ref.id,
  name: ref.name,
  fields: fields.filter((entry): entry is FieldInput => Boolean(entry)),
  badges,
});

/**
 * `Product.brandName` is free text, so it is a fact rather than a link.
 * Absent stays absent unless the card is about identity, where the gap is the
 * defect and reads as a warning dash.
 */
export const manufacturerField = (
  brandName: string | null | undefined,
  { missingIsDefect = false }: { missingIsDefect?: boolean } = {},
) =>
  brandName
    ? field("Manufacturer", brandName)
    : missingIsDefect
      ? field("Manufacturer", "—", "warning")
      : null;
