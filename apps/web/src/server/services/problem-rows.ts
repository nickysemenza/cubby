import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";
import type { problemRowSchema } from "@cubby/schemas/problems";
import type { z } from "zod";

export type ProblemRowInput = z.input<typeof problemRowSchema>;
type BadgeInput = ProblemRowInput["badges"][number];
type Ref = { id: string; name: string };

/** A badge naming a record; the page links it to that record. */
export const recordBadge = (entity: ShortcodeEntity, ref: Ref): BadgeInput => ({
  label: ref.name,
  entity,
  id: ref.id,
});

export const textBadge = (label: string): BadgeInput => ({
  label,
  entity: null,
  id: null,
});

export const locationBadges = (locations: readonly Ref[]): BadgeInput[] =>
  locations.map((location) => recordBadge("location", location));

/** The uniform Problems row; falsy subtitle parts are dropped, the rest joined. */
export const problemRow = (
  entity: ShortcodeEntity,
  ref: Ref,
  subtitle: readonly (string | null | undefined | false)[],
  badges: BadgeInput[] = [],
): ProblemRowInput => {
  const parts = subtitle.filter((part): part is string => Boolean(part));
  return {
    entity,
    id: ref.id,
    name: ref.name,
    subtitle: parts.length ? parts.join(" · ") : null,
    badges,
  };
};

export const byManufacturer = (manufacturer: string | null | undefined) =>
  manufacturer ? `by ${manufacturer}` : null;
