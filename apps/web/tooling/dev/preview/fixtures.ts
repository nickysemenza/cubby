import type { BrowserRoutedEntity } from "@cubby/schemas/entity-manifest";
import { entitySummary } from "@cubby/schemas/entity-summary";
import { z } from "zod";

import { isBrowserRoutedEntity } from "~/entity/entities";
import {
  getEntityListOutputSchema,
  type ListEntity,
  listEntities,
} from "~/entity/generated/entity-lists.gen";
import { mock } from "~/lib/test/mock-schema";
import type { BaseListRow } from "~/ui/hooks/useEntityList";
import type { ListQueryOptionsFn } from "~/ui/hooks/usePaginatedTableCore";

export const PREVIEW_STATES = ["loading", "error", "empty", "edge"] as const;
export const previewStateSchema = z.enum(PREVIEW_STATES).catch("edge");
export type PreviewState = z.infer<typeof previewStateSchema>;

/** Entities with both a generic list read and a browser list route. */
export const PREVIEW_ENTITIES = listEntities.filter(
  (entity): entity is ListEntity & BrowserRoutedEntity =>
    isBrowserRoutedEntity(entity) &&
    entitySummary[entity].list.views.length > 0,
);
export type PreviewEntity = (typeof PREVIEW_ENTITIES)[number];
export const previewEntitySchema = z.enum(PREVIEW_ENTITIES).catch("task");

/**
 * Edge rows: schema-valid records (optionals omitted, nullables null — the
 * sparse shape a list must tolerate) with titles that stress wrapping.
 * Everything else comes from the entity's own list output schema, so a schema
 * change reshapes the preview instead of drifting from it. `fillOptionals`
 * is avoided: it can violate cross-field refinements such as amount bounds.
 */
const EDGE_TITLES = [
  "Minimal record",
  "A synthetic record whose title keeps going well past the width any list column reserves for it",
  `Unbroken-${"x".repeat(96)}`,
] as const;

function edgeRows(entity: PreviewEntity): BaseListRow[] {
  const schema = getEntityListOutputSchema(entity);
  const titleField = entitySummary[entity].titleField;
  return EDGE_TITLES.flatMap((title, index) =>
    mock(schema, { seed: index + 1 }).items.map((item) => ({
      ...item,
      [titleField]: title,
    })),
  );
}

/** A Postgres-shaped failure: error surfaces show raw diagnostics. */
function previewFailure(entity: PreviewEntity) {
  return Object.assign(
    new Error(
      `relation "${entity}_preview" does not exist (SQLSTATE 42P01) — synthetic preview failure`,
    ),
    { code: "INTERNAL_SERVER_ERROR" },
  );
}

/** The generic list's read seam, answered from fixtures instead of the Worker. */
export function previewListOperation(
  entity: PreviewEntity,
  state: PreviewState,
): ListQueryOptionsFn<object, BaseListRow> {
  const rows = state === "edge" ? edgeRows(entity) : [];
  return (params) => ({
    queryKey: ["dev-preview", entity, state, params],
    execute: (signal) => {
      if (state === "loading")
        return new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason)),
        );
      if (state === "error") return Promise.reject(previewFailure(entity));
      return Promise.resolve({
        items: rows,
        meta: { ...params.pagination, totalCount: rows.length },
      });
    },
  });
}
