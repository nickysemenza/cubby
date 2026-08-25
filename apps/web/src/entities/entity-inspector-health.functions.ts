import type { Entity } from "@cubby/schemas/entity";
import type { SearchableEntity } from "@cubby/schemas/search";
import { queryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { startOperation } from "~/integrations/tanstack-query/start-transport";
import * as entityRuntime from "~/server/entity-runtime.server";
import { authenticatedStartServerFunction } from "~/server/middleware/entity-server-functions";

export type EntityInspectorHealth = {
  counts: Partial<Record<Entity, number>>;
  search: Partial<
    Record<SearchableEntity, { documents: number; embeddings: number }>
  >;
};

const getEntityInspectorHealth = createServerFn({ method: "GET" })
  .middleware([authenticatedStartServerFunction])
  .handler(
    async ({ context }) =>
      await entityRuntime.getEntityInspectorHealth({
        request: context.startOperation,
      }),
  );

const inspectorHealthOperation = startOperation<null, EntityInspectorHealth>({
  operation: "entity.inspectorHealth",
  transport: (_input, { signal, headers }) =>
    getEntityInspectorHealth({ signal, headers }),
  parse: (result) => result as EntityInspectorHealth,
});

export const entityInspectorHealthQueryOptions = (enabled: boolean) =>
  queryOptions({
    queryKey: [["entity", "inspector-health"]],
    meta: inspectorHealthOperation.meta,
    queryFn: ({ signal }) => inspectorHealthOperation.call(null, { signal }),
    enabled,
    staleTime: 60_000,
  });
