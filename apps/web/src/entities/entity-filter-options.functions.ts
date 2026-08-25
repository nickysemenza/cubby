import {
  type FilterOptionsInput,
  type FilterOptionsOut,
  filterOptionsOut,
} from "@cubby/schemas/filter-options";
import { queryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import {
  observedStartCall,
  unwrapStartOperationResult,
} from "~/integrations/tanstack-query/start-transport";
import * as entityRuntime from "~/server/entity-runtime.server";
import { authenticatedStartServerFunction } from "~/server/middleware/entity-server-functions";

const getEntityFilterOptionsTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator((input: unknown) => input as FilterOptionsInput)
  .handler(
    async ({ data, context }) =>
      await entityRuntime.getEntityFilterOptions({
        data,
        request: context.startOperation,
      }),
  );

async function getEntityFilterOptions(options: {
  data: FilterOptionsInput;
  signal?: AbortSignal;
}): Promise<FilterOptionsOut> {
  return await observedStartCall({
    operation: "entity.filterOptions",
    input: options.data,
    call: async (headers) =>
      filterOptionsOut.parse(
        unwrapStartOperationResult(
          "entity.filterOptions",
          await getEntityFilterOptionsTransport({
            data: options.data,
            signal: options.signal,
            headers,
          }),
        ),
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
