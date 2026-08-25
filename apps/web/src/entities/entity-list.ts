import { MAX_PAGE_SIZE, MAX_SORTS } from "@cubby/schemas/pagination";
import { queryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import {
  observedEntityCall,
  type PublicEntityError,
  unwrapEntityTransportResult,
} from "./entity-transport";
import {
  type EntityListInputByEntity,
  type EntityListResultByEntity,
  type ListEntity,
  listEntities,
} from "./generated/entity-lists.gen";

const sortSchema = z.object({
  orderBy: z.string().min(1),
  direction: z.enum(["asc", "desc"]),
});

const listTransportInput = z.object({
  entity: z.enum(listEntities),
  filters: z.record(z.string(), z.unknown()),
  sort: z
    .union([sortSchema, z.array(sortSchema).min(1).max(MAX_SORTS)])
    .optional(),
  pagination: z
    .object({
      pageIndex: z.number().int().min(0),
      pageSize: z.number().int().min(1).max(MAX_PAGE_SIZE),
    })
    .optional(),
  groupBy: z.string().min(1).optional(),
});

type ListTransportResult =
  | { ok: true; data: EntityListResultByEntity[ListEntity] }
  | { ok: false; error: PublicEntityError };

const getEntityListTransport = createServerFn({ method: "POST" })
  .validator(listTransportInput)
  .handler(async ({ data }): Promise<ListTransportResult> => {
    const [transportModule, kernelModule] = await Promise.all([
      import("~/server/entity-read-transport"),
      import("~/server/entity-kernel"),
    ]);
    return await transportModule.runEntityReadTransport({
      operation: "entity.list",
      input: data,
      headers: getRequest().headers,
      execute: async (context) => {
        const result = await kernelModule.executeEntity(context, {
          action: "list",
          ...data,
        });
        if (result.action !== "list") {
          throw new Error("Entity kernel returned the wrong action");
        }
        return {
          items: result.items,
          meta: result.meta,
        } as EntityListResultByEntity[ListEntity];
      },
    });
  });

type EntityListParams<E extends ListEntity> = Omit<
  EntityListInputByEntity[E],
  "entity"
>;

async function getEntityList<E extends ListEntity>(options: {
  data: EntityListInputByEntity[E];
  signal?: AbortSignal;
}): Promise<EntityListResultByEntity[E]> {
  return await observedEntityCall("entity.list", options.data, async () => {
    const result = await getEntityListTransport(options);
    return unwrapEntityTransportResult(
      "entity.list",
      result,
    ) as EntityListResultByEntity[E];
  });
}

const entityListQueryKey = <E extends ListEntity>(
  entity: E,
  input: EntityListParams<E>,
) => [[entity, "list"], { input }] as const;

export function entityListQueryOptions<E extends ListEntity>(
  entity: E,
  input: EntityListParams<E>,
) {
  return queryOptions({
    queryKey: entityListQueryKey(entity, input),
    queryFn: ({ signal }) =>
      getEntityList({
        data: { entity, ...input } as EntityListInputByEntity[E],
        signal,
      }),
  });
}
