import { z } from "zod";

/** The wire shape of a server-composed list label: text, or absent. */
export const listLabel = z.string().nullish();

/**
 * A server-composed list label: the text a computed column prints, carried on
 * the list row so web and native show one rule instead of re-deriving it. The
 * column it serves names this key in `display.labelPath`; the label itself is
 * never listed, filtered or sorted.
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
