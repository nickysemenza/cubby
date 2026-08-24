import { queryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import {
  EntityTransportError,
  observedEntityCall,
  type PublicEntityError,
} from "./entity-transport";
import type {
  EntityDetailByEntity,
  EntityDetailInputByEntity,
} from "./generated/entity-details.gen";
import {
  type DetailEntity,
  detailEntities,
} from "./generated/entity-details.gen";

const detailTransportInput = z.object({
  entity: z.enum(detailEntities),
  shortcode: z.string().min(1),
});

type DetailTransportResult =
  | { ok: true; data: EntityDetailByEntity[DetailEntity] | null }
  | { ok: false; error: PublicEntityError };

const getEntityDetailTransport = createServerFn({ method: "GET" })
  .validator(detailTransportInput)
  .handler(async ({ data }): Promise<DetailTransportResult> => {
    const [transportModule, kernelModule, bindingModule] = await Promise.all([
      import("~/server/entity-read-transport"),
      import("~/server/entity-kernel"),
      import("~/server/generated/entity-bindings.gen"),
    ]);
    return await transportModule.runEntityReadTransport({
      operation: "entity.detail",
      input: data,
      headers: getRequest().headers,
      execute: async (context) => {
        const input = bindingModule.entityDetailInputSchema.parse(data);
        const result = await kernelModule.executeEntity(context, {
          action: "get",
          entity: input.entity,
          id: input.shortcode,
          missing: "null",
        });
        if (result.action !== "get") {
          throw new Error("Entity kernel returned the wrong action");
        }
        return (
          result.item === null
            ? null
            : bindingModule.ENTITY_DETAIL_OUTPUT_SCHEMAS[input.entity].parse(
                result.item,
              )
        ) as EntityDetailByEntity[DetailEntity] | null;
      },
    });
  });

export class EntityDetailError extends EntityTransportError {
  constructor(error: PublicEntityError) {
    super(error);
    this.name = "EntityDetailError";
  }
}

async function getEntityDetail<E extends DetailEntity>(options: {
  data: EntityDetailInputByEntity[E];
  signal?: AbortSignal;
}): Promise<EntityDetailByEntity[E] | null> {
  return await observedEntityCall("entity.detail", options.data, async () => {
    const result = await getEntityDetailTransport(options);
    if (!result.ok) throw new EntityDetailError(result.error);
    return result.data as EntityDetailByEntity[E] | null;
  });
}

export const entityDetailQueryKey = <E extends DetailEntity>(
  entity: E,
  shortcode: string,
) => [[entity, "detail"], { shortcode }] as const;

export const entityDetailRootKey = <E extends DetailEntity>(entity: E) =>
  [[entity, "detail"]] as const;

export function entityDetailQueryOptions<E extends DetailEntity>(
  entity: E,
  shortcode: EntityDetailInputByEntity[E]["shortcode"],
  options?: { enabled?: boolean },
) {
  return queryOptions({
    queryKey: entityDetailQueryKey(entity, shortcode),
    queryFn: ({ signal }) =>
      getEntityDetail({
        data: { entity, shortcode } as EntityDetailInputByEntity[E],
        signal,
      }),
    ...options,
  });
}
