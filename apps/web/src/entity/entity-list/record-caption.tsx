import { entityFieldModels } from "@cubby/schemas/entity-fields";
import type { BrowserRoutedEntity } from "@cubby/schemas/entity-manifest";
import { entitySummary } from "@cubby/schemas/entity-summary";
import type { ReactNode } from "react";
import { z } from "zod";

import { renderCompactFieldValue } from "~/entity/display/entity-display";
import type { ListGroupState } from "~/entity/hooks/progressive-list";

import { DeferredListValue } from "./deferred-list-value";

/** A list row as a caption reads it: its id and whichever fields it names. */
const captionRowSchema = z.looseObject({ id: z.string() });

/**
 * A record's caption is the first declared `shelf.subtitle` field with a
 * value (a shelf card's subtitle),
 * rendered through its declared format — a price reads as money, a category
 * as its label.
 */
export function recordCaption(
  entity: BrowserRoutedEntity,
  row: z.infer<typeof captionRowSchema>,
  options: {
    enrichmentState?: (id: string, field: string) => ListGroupState | undefined;
  } = {},
): ReactNode {
  const subtitle = entitySummary[entity].list.shelf?.subtitle ?? [];
  const fields = entityFieldModels[entity].fields;
  for (const key of subtitle) {
    const field = fields.find((candidate) => candidate.key === key);
    if (!field) continue;
    const state = options.enrichmentState?.(row.id, field.readKey ?? field.key);
    if (state && state.state !== "ready")
      return (
        <span className="block h-4 leading-4">
          <DeferredListValue state={state} />
        </span>
      );
    const value = row[field.readKey ?? field.key];
    if (
      value == null ||
      value === "" ||
      (Array.isArray(value) && value.length === 0)
    )
      continue;
    return renderCompactFieldValue(entity, row, field);
  }
  return options.enrichmentState && subtitle.length > 0 ? (
    <span className="block h-4" />
  ) : undefined;
}
