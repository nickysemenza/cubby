import type { Entity } from "@cubby/schemas/entity";
import type { SearchableEntity } from "@cubby/schemas/search";
import { queryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import {
  observedStartCall,
  unwrapStartOperationResult,
} from "~/integrations/tanstack-query/start-transport";
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

export const entityInspectorHealthQueryOptions = (enabled: boolean) =>
  queryOptions({
    queryKey: [["entity", "inspector-health"]],
    queryFn: ({ signal }) =>
      observedStartCall({
        operation: "entity.inspectorHealth",
        input: null,
        call: async (headers) =>
          unwrapStartOperationResult(
            "entity.inspectorHealth",
            await getEntityInspectorHealth({ signal, headers }),
          ),
      }),
    meta: {
      transport: "start",
      operation: "entity.inspectorHealth",
      observedByTransport: true,
    },
    enabled,
    staleTime: 60_000,
  });
