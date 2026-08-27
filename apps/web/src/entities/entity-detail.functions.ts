import { parseShortcode } from "@cubby/shared";
import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";
import {
  defineOperationDomain,
  type OperationQueryKey,
  query,
} from "~/integrations/tanstack-query/operation-catalog";
import type {
  CubbyOperationMeta,
  OperationFreshnessPolicy,
} from "~/integrations/tanstack-query/operation-meta";
import {
  type DetailEntity,
  type EntityDetailByEntity,
  type EntityDetailInputByEntity,
  parseEntityDetailInput,
  parseEntityDetailResult,
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

/**
 * A catalog descriptor is parameterized by one schema pair, so its
 * `forEntity(entity: string)` cannot narrow `entity.detail` to a single
 * entity's input and output. This declaration plus the one cast in
 * `entityDetailFor` buy that narrowing once, for every caller.
 */
type ScopedDetailOperation<E extends DetailEntity> = {
  policy(input: EntityDetailInputByEntity[E]): {
    meta: CubbyOperationMeta;
    freshness?: OperationFreshnessPolicy;
  };
  queryKey(
    input: EntityDetailInputByEntity[E],
  ): OperationQueryKey<EntityDetailInputByEntity[E]>;
  call(
    input: EntityDetailInputByEntity[E],
    options: { signal?: AbortSignal },
  ): Promise<EntityDetailByEntity[E] | null>;
};

/**
 * Bind `entity.detail` to one entity, so its shortcode, result, and cache key
 * all carry that entity's types. Throws for an entity the operation is not
 * registered for.
 */
export function entityDetailFor<E extends DetailEntity>(entity: E) {
  const operation = entityDetail.detail.forEntity(
    entity,
  ) as unknown as ScopedDetailOperation<E>;
  // A physical label ("p-4k7m") and its canonical shortcode address the same
  // row, so both have to resolve to a single cache entry.
  const inputFor = (shortcode: string) => {
    const parsed = parseShortcode(shortcode);
    return {
      entity,
      shortcode: parsed?.type === entity ? parsed.shortcode : shortcode,
    } as EntityDetailInputByEntity[E];
  };
  return {
    entity,
    queryKey: (shortcode: string) => operation.queryKey(inputFor(shortcode)),
    queryOptions: (
      shortcode: string,
      options?: { enabled?: boolean; staleTime?: number },
    ) => {
      const input = inputFor(shortcode);
      const policy = operation.policy(input);
      return queryOptions({
        queryKey: operation.queryKey(input),
        // Some conditional detail queries use an empty placeholder while
        // disabled. Validate when React Query actually executes, not while
        // rendering options.
        queryFn: async ({ signal }) =>
          operation.call(parseEntityDetailInput(entity, input), { signal }),
        meta: policy.meta,
        ...policy.freshness,
        ...options,
      });
    },
  };
}

export type EntityDetailScoped<E extends DetailEntity> = ReturnType<
  typeof entityDetailFor<E>
>;
