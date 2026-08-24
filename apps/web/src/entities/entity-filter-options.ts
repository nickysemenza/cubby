import {
  type FilterOptionsInput,
  type FilterOptionsOut,
  filterOptionsInput,
} from "@cubby/schemas/filter-options";
import { queryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import {
  EntityTransportError,
  observedEntityCall,
  type PublicEntityError,
} from "./entity-transport";

type FilterOptionsTransportResult =
  | { ok: true; data: FilterOptionsOut }
  | { ok: false; error: PublicEntityError };

const getEntityFilterOptionsTransport = createServerFn({ method: "POST" })
  .validator(filterOptionsInput)
  .handler(async ({ data }): Promise<FilterOptionsTransportResult> => {
    const [transportModule, repositoryModule] = await Promise.all([
      import("~/server/entity-read-transport"),
      import("~/server/repo/filter-options"),
    ]);
    return await transportModule.runEntityReadTransport({
      operation: "entity.filterOptions",
      input: data,
      headers: getRequest().headers,
      execute: async (context) =>
        repositoryModule.getFilterOptions(context.db, data),
    });
  });

export async function getEntityFilterOptions(options: {
  data: FilterOptionsInput;
  signal?: AbortSignal;
}): Promise<FilterOptionsOut> {
  return await observedEntityCall(
    "entity.filterOptions",
    options.data,
    async () => {
      const result = await getEntityFilterOptionsTransport(options);
      if (!result.ok) throw new EntityTransportError(result.error);
      return result.data;
    },
  );
}

export function entityFilterOptionsQueryOptions(input: FilterOptionsInput) {
  return queryOptions({
    queryKey: [["entity", "filterOptions"], { input }] as const,
    queryFn: ({ signal }) => getEntityFilterOptions({ data: input, signal }),
  });
}
