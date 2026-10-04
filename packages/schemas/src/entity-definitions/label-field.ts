import { z } from "zod";

/** The wire shape of a server-composed display label: text, or absent. */
export const listLabel = z.string().nullish();

/**
 * A server-composed display label: the text a computed column or a structured
 * detail field prints, carried on the record so web and native show one rule
 * instead of re-deriving it. The field it serves names this key in
 * `display.labelPath` (list cell) or `display.detailLabelPath` (detail row);
 * the label itself is never listed, filtered or sorted.
 */
export const labelField = <const Key extends string>(
  key: Key,
  source: string,
) => ({
  key,
  kind: "text" as const,
  nullable: true as const,
  provenance: { kind: "derived" as const, sources: [{ label: source }] },
  validation: { read: listLabel, create: null, update: null },
});

/**
 * One row of a server-composed display list (`display.itemsPath`): a title, an
 * optional second line and trailing figure already worded, and the record the
 * row opens when it names one. Clients draw the rows; none re-derives a figure.
 */
export const displayItem = z.object({
  entity: z.string().nullable(),
  id: z.string().nullable(),
  title: z.string(),
  subtitle: z.string().nullable(),
  trailing: z.string().nullable(),
});
export type DisplayItem = z.infer<typeof displayItem>;

/** The wire shape of a display list: items, or absent. */
export const displayItems = z.array(displayItem).nullish();

/** A server-composed display list a field's `display.itemsPath` names. */
export const displayItemsField = <const Key extends string>(
  key: Key,
  source: string,
) => ({
  key,
  kind: "json" as const,
  nullable: true as const,
  provenance: { kind: "derived" as const, sources: [{ label: source }] },
  validation: { read: displayItems, create: null, update: null },
});
