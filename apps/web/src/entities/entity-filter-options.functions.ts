import {
  type FilterOptionsInput,
  type FilterOptionsOut,
  filterOptionsInput,
} from "@cubby/schemas/filter-options";
import { queryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import * as entityRuntime from "~/server/entity-runtime.server";
import { authenticatedEntityServerFunction } from "~/server/middleware/entity-server-functions";
import {
  observedEntityCall,
  unwrapEntityTransportResult,
} from "./entity-transport";

const getEntityFilterOptionsTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedEntityServerFunction])
  .validator(filterOptionsInput)
  .handler(
    async ({ data, context }) =>
      await entityRuntime.getEntityFilterOptions({
        data,
        request: context.entityRuntime,
      }),
  );

async function getEntityFilterOptions(options: {
  data: FilterOptionsInput;
  signal?: AbortSignal;
}): Promise<FilterOptionsOut> {
  return await observedEntityCall({
    operation: "entity.filterOptions",
    input: options.data,
    call: async (headers) =>
      unwrapEntityTransportResult(
        "entity.filterOptions",
        await getEntityFilterOptionsTransport({
          data: options.data,
          signal: options.signal,
          headers,
        }),
      ),
  });
}

export function entityFilterOptionsQueryOptions(input: FilterOptionsInput) {
  return queryOptions({
    queryKey: [["entity", "filterOptions"], { input }] as const,
    meta: {
      transport: "start",
      operation: "entity.filterOptions",
      observedByTransport: true,
    },
    queryFn: ({ signal }) => getEntityFilterOptions({ data: input, signal }),
  });
}
