import { parseShortcode } from "@cubby/shared";
import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";
import {
  defineOperationDomain,
  type OperationQueryKey,
  query,
} from "~/integrations/tanstack-query/operation-catalog";
import type {
  DetailEntity,
  EntityDetailByEntity,
  EntityDetailInputByEntity,
} from "./generated/entity-details.gen";

const persistedDetailEntities = new Set<DetailEntity>([
  "product",
  "location",
  "recipe",
  "ingredient",
  "inventory",
]);
const stableDetailFreshness = {
  staleTime: 5 * 60_000,
  gcTime: 24 * 60 * 60_000,
  refetchOnWindowFocus: true,
  refetchOnReconnect: true,
} as const;

import {
  parseEntityDetailInput,
  parseEntityDetailResult,
} from "./generated/entity-details.gen";

/** Compatibility error shape for browser error renderers. */
export class EntityDetailError extends Error {
  readonly data: { code: string; reason: string };

  constructor(error: { code: string; reason: string; message: string }) {
    super(error.message);
    this.name = "EntityDetailError";
    this.data = { code: error.code, reason: error.reason };
  }
}

/** @lintignore Discovered by the operation registry generator. */
export const entityDetail = defineOperationDomain("entity", {
  detail: query({
    input: z.custom<EntityDetailInputByEntity[DetailEntity]>(),
    output: z.custom<EntityDetailByEntity[DetailEntity] | null>(),
    parse: (result, input) =>
      result === null ? null : parseEntityDetailResult(input.entity, result),
    tags: [["entity", "detail"]],
    persistence: (input) =>
      persistedDetailEntities.has(input.entity) ? "persist" : "memory",
    freshness: (input) =>
      persistedDetailEntities.has(input.entity)
        ? stableDetailFreshness
        : undefined,
  }),
});

export const entityDetailQueryKey = <E extends DetailEntity>(
  entity: E,
  shortcode: string,
) => {
  const parsed = parseShortcode(shortcode);
  const canonical = parsed?.type === entity ? parsed.shortcode : shortcode;
  return entityDetail.detail
    .forEntity(entity)
    .queryKey({ entity, shortcode: canonical });
};

export const entityDetailRootKey = <E extends DetailEntity>(entity: E) =>
  entityDetail.detail
    .forEntity(entity)
    .queryKey({
      entity,
      shortcode: "",
    })
    .slice(0, 2);

export function entityDetailQueryOptions<E extends DetailEntity>(
  entity: E,
  shortcode: EntityDetailInputByEntity[E]["shortcode"],
  options?: { enabled?: boolean; staleTime?: number },
) {
  const queryKey = entityDetailQueryKey(entity, shortcode);
  const operation = entityDetail.detail.forEntity(entity);
  const input = {
    entity,
    shortcode: queryKey[2].input.shortcode,
  } as EntityDetailInputByEntity[E];
  const policy = operation.policy(input);
  return queryOptions({
    queryKey: queryKey as OperationQueryKey<EntityDetailInputByEntity[E]>,
    // Some conditional detail queries use an empty placeholder while disabled.
    // Validate when React Query actually executes, not while rendering options.
    queryFn: async ({ signal }) => {
      const parsed = parseEntityDetailInput(
        entity,
        input,
      ) as EntityDetailInputByEntity[E];
      return (await operation.call(parsed, { signal })) as
        | EntityDetailByEntity[E]
        | null;
    },
    meta: policy.meta,
    ...policy.freshness,
    ...options,
  });
}
