import { parseShortcode } from "@cubby/shared";
import { queryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import {
  observedStartCall,
  type PublicStartOperationError,
  StartOperationError,
  unwrapStartOperationResult,
} from "~/integrations/tanstack-query/start-transport";
import * as entityRuntime from "~/server/entity-runtime.server";
import { authenticatedStartServerFunction } from "~/server/middleware/entity-server-functions";
import type {
  DetailEntity,
  EntityDetailByEntity,
  EntityDetailInputByEntity,
} from "./generated/entity-details.gen";
import {
  parseEntityDetailInput,
  parseEntityDetailResult,
} from "./generated/entity-details.gen";

const getEntityDetailTransport = createServerFn({ method: "GET" })
  .middleware([authenticatedStartServerFunction])
  .validator(
    (input: unknown) =>
      input as EntityDetailInputByEntity[keyof EntityDetailByEntity],
  )
  .handler(
    async ({ data, context }) =>
      await entityRuntime.getEntityDetail({
        data,
        request: context.startOperation,
      }),
  );

export class EntityDetailError extends StartOperationError {
  constructor(error: PublicStartOperationError) {
    super(error);
    this.name = "EntityDetailError";
  }
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

async function getEntityDetail<E extends DetailEntity>(options: {
  entity: E;
  data: EntityDetailInputByEntity[E];
  signal?: AbortSignal;
  speculative?: boolean;
}): Promise<EntityDetailByEntity[E] | null> {
  return await observedStartCall({
    operation: "entity.detail",
    entity: options.data.entity,
    speculative: options.speculative,
    input: options.data,
    call: async (headers) => {
      const result = unwrapStartOperationResult(
        "entity.detail",
        await getEntityDetailTransport({
          data: options.data,
          signal: options.signal,
          headers,
        }),
        (error) => new EntityDetailError(error),
      );
      return result === null
        ? null
        : parseEntityDetailResult(options.entity, result);
    },
  });
}

export function entityDetailQueryOptions<E extends DetailEntity>(
  entity: E,
  shortcode: EntityDetailInputByEntity[E]["shortcode"],
  options?: { enabled?: boolean; staleTime?: number },
) {
  const queryKey = entityDetailQueryKey(entity, shortcode);
  return queryOptions({
    queryKey,
    meta: {
      transport: "start",
      operation: "entity.detail",
      entity,
      observedByTransport: true,
    },
    queryFn: ({ signal, meta }) =>
      getEntityDetail({
        entity,
        data: parseEntityDetailInput(entity, {
          entity,
          shortcode: queryKey[1].shortcode,
        }),
        signal,
        speculative: meta?.speculative,
      }),
    ...options,
  });
}
