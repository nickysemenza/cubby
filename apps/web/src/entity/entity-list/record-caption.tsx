import type { BrowserRoutedEntity } from "@cubby/schemas/entity-manifest";
import { type QueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { z } from "zod";

import { renderCompactFieldValue } from "~/entity/display/entity-display";
import { entityMetadata } from "~/entity/metadata";
import { readPathValue } from "~/entity/read-path";

/** A list row as a caption reads it: its id and whichever fields it names. */
const captionRowSchema = z.looseObject({ id: z.string() });

/**
 * A record's caption is the first declared `shelf.subtitle` field with a
 * value (a shelf card's subtitle),
 * rendered through its declared format — a price reads as money, a category
 * as its label.
 */
export function recordCaption(
  queryClient: QueryClient,
  entity: BrowserRoutedEntity,
  row: z.infer<typeof captionRowSchema>,
): ReactNode {
  const subtitle =
    entityMetadata(queryClient, entity).summary.list.shelf?.subtitle ?? [];
  const fields = entityMetadata(queryClient, entity).fields.fields;
  for (const key of subtitle) {
    const field = fields.find((candidate) => candidate.key === key);
    if (!field) continue;
    const value = readPathValue(row, field.readKey ?? field.key);
    if (
      value == null ||
      value === "" ||
      (Array.isArray(value) && value.length === 0)
    )
      continue;
    return renderCompactFieldValue(queryClient, entity, row, field);
  }
  return undefined;
}
