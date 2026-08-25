import {
  type FilterOptionsInput,
  type FilterOptionsOut,
  filterOptionsOut,
} from "@cubby/schemas/filter-options";
import { queryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { startOperation } from "~/integrations/tanstack-query/start-transport";
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

const filterOptionsOperation = startOperation<
  FilterOptionsInput,
  FilterOptionsOut
>({
  operation: "entity.filterOptions",
  transport: (data, { signal, headers }) =>
    getEntityFilterOptionsTransport({ data, signal, headers }),
  parse: (result) => filterOptionsOut.parse(result),
});

export function entityFilterOptionsQueryOptions(input: FilterOptionsInput) {
  return queryOptions({
    queryKey: [["entity", "filterOptions"], { input }] as const,
    meta: filterOptionsOperation.meta,
    queryFn: ({ signal }) => filterOptionsOperation.call(input, { signal }),
  });
}
