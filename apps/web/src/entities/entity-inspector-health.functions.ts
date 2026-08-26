import type { Entity } from "@cubby/schemas/entity";
import type { SearchableEntity } from "@cubby/schemas/search";
import { z } from "zod";
import {
  defineOperationDomain,
  query,
} from "~/integrations/tanstack-query/operation-catalog";

export type EntityInspectorHealth = {
  counts: Partial<Record<Entity, number>>;
  search: Partial<
    Record<SearchableEntity, { documents: number; embeddings: number }>
  >;
};

export const entityInspectorHealth = defineOperationDomain("entity", {
  inspectorHealth: query({
    input: z.null(),
    output: z.custom<EntityInspectorHealth>(),
    tags: [["entity", "inspectorHealth"]],
    freshness: { staleTime: 60_000 },
  }),
});
