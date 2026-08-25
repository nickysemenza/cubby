import { parseShortcode } from "@cubby/shared";
import { queryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import {
  StartOperationError,
  startOperation,
} from "~/integrations/tanstack-query/start-transport";
import * as entityRuntime from "~/server/entity-runtime.server";
import { authenticatedStartServerFunction } from "~/server/middleware/entity-server-functions";
import type { PublicStartOperationError } from "~/server/start-operation.contract";
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

const entityDetailOperation = startOperation<
  EntityDetailInputByEntity[DetailEntity],
  EntityDetailByEntity[DetailEntity] | null
>({
  operation: "entity.detail",
  transport: (data, { signal, headers }) =>
    getEntityDetailTransport({ data, signal, headers }),
  parse: (result, input) =>
    result === null ? null : parseEntityDetailResult(input.entity, result),
  createError: (error) => new EntityDetailError(error),
});

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
  const operation = entityDetailOperation.forEntity(entity);
  return queryOptions({
    queryKey,
    meta: operation.meta,
    queryFn: ({ signal, meta }) =>
      operation.call(
        parseEntityDetailInput(entity, {
          entity,
          shortcode: queryKey[1].shortcode,
        }),
        { signal, speculative: meta?.speculative },
      ) as Promise<EntityDetailByEntity[E] | null>,
    ...options,
  });
}
