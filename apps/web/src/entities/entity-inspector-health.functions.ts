import type { Entity } from "@cubby/schemas/entity";
import type { SearchableEntity } from "@cubby/schemas/search";
import { queryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import * as entityRuntime from "~/server/entity-runtime.server";
import { authenticatedEntityServerFunction } from "~/server/middleware/entity-server-functions";
import { observedEntityCall } from "./entity-transport";

export type EntityInspectorHealth = {
  counts: Partial<Record<Entity, number>>;
  search: Partial<
    Record<SearchableEntity, { documents: number; embeddings: number }>
  >;
};

const getEntityInspectorHealth = createServerFn({ method: "GET" })
  .middleware([authenticatedEntityServerFunction])
  .handler(
    async ({ context }) =>
      await entityRuntime.getEntityInspectorHealth({
        request: context.entityRuntime,
      }),
  );

export const entityInspectorHealthQueryOptions = (enabled: boolean) =>
  queryOptions({
    queryKey: [["entity", "inspector-health"]],
    queryFn: ({ signal }) =>
      observedEntityCall({
        operation: "entity.inspectorHealth",
        input: null,
        call: (headers) => getEntityInspectorHealth({ signal, headers }),
      }),
    meta: {
      transport: "start",
      operation: "entity.inspectorHealth",
      observedByTransport: true,
    },
    enabled,
    staleTime: 60_000,
  });
