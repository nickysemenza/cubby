import { parseShortcode } from "@cubby/shared";
import { queryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import {
  EntityTransportError,
  observedEntityCall,
  type PublicEntityError,
  unwrapEntityTransportResult,
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
    return unwrapEntityTransportResult(
      "entity.detail",
      result,
      (error) => new EntityDetailError(error),
    ) as EntityDetailByEntity[E] | null;
  });
}

export const entityDetailQueryKey = <E extends DetailEntity>(
  entity: E,
  shortcode: string,
) => {
  const parsed = parseShortcode(shortcode);
  const canonical = parsed?.type === entity ? parsed.shortcode : shortcode;
  return [[entity, "detail"], { shortcode: canonical }] as const;
};

export const entityDetailRootKey = <E extends DetailEntity>(entity: E) =>
  [[entity, "detail"]] as const;

export function entityDetailQueryOptions<E extends DetailEntity>(
  entity: E,
  shortcode: EntityDetailInputByEntity[E]["shortcode"],
  options?: { enabled?: boolean; staleTime?: number },
) {
  const queryKey = entityDetailQueryKey(entity, shortcode);
  const canonicalShortcode = queryKey[1].shortcode;
  return queryOptions({
    queryKey,
    queryFn: ({ signal }) =>
      getEntityDetail({
        data: {
          entity,
          shortcode: canonicalShortcode,
        } as EntityDetailInputByEntity[E],
        signal,
      }),
    ...options,
  });
}
