import { parseShortcode } from "@cubby/shared";
import { queryOptions } from "@tanstack/react-query";

import { entityDetailContract } from "~/contracts/entity-detail.contract";
import {
  defineOperationDomain,
  type OperationQueryKey,
} from "~/integrations/tanstack-query/operation-catalog";

import {
  type DetailEntity,
  type EntityDetailInputByEntity,
  entityDetailInputFor,
  getEntityDetailOutputSchema,
  parseEntityDetailInput,
} from "./generated/entity-details.gen";

const persistedDetailEntities = new Set<DetailEntity>([
  "product",
  "location",
  "recipe",
  "ingredient",
  "inventory",
]);
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
export const entityDetail = defineOperationDomain(entityDetailContract, {
  detail: {
    parse: (result, input) =>
      result === null
        ? null
        : getEntityDetailOutputSchema(input.entity).parse(result),
    tags: [["entity", "detail"]],
    cache: (input) =>
      persistedDetailEntities.has(input.entity)
        ? "persisted-detail"
        : undefined,
  },
});

/**
 * Bind `entity.detail` to one entity, so its shortcode, result, and cache key
 * all carry that entity's types. Throws for an entity the operation is not
 * registered for.
 */
export function entityDetailFor<E extends DetailEntity>(entity: E) {
  const operation = entityDetail.detail.forEntity(entity);
  // A physical label ("p-4k7m") and its canonical shortcode address the same
  // row, so both have to resolve to a single cache entry.
  const inputFor = (shortcode: string) => {
    const parsed = parseShortcode(shortcode);
    return entityDetailInputFor(
      entity,
      parsed?.type === entity ? parsed.shortcode : shortcode,
    );
  };
  const queryKeyFor = (
    input: EntityDetailInputByEntity[E],
  ): OperationQueryKey<EntityDetailInputByEntity[E]> => [
    "operation",
    operation.id,
    { entity, input },
  ];
  return {
    entity,
    queryKey: (shortcode: string) => queryKeyFor(inputFor(shortcode)),
    readFresh: async (shortcode: string) => {
      const input = inputFor(shortcode);
      const result = await operation.call(
        parseEntityDetailInput(entity, input),
      );
      return result === null
        ? null
        : getEntityDetailOutputSchema(entity).parse(result);
    },
    queryOptions: (
      shortcode: string,
      options?: { enabled?: boolean; staleTime?: number },
    ) => {
      const input = inputFor(shortcode);
      const policy = operation.policy(input);
      return queryOptions({
        queryKey: queryKeyFor(input),
        // Some conditional detail queries use an empty placeholder while
        // disabled. Validate when React Query actually executes, not while
        // rendering options.
        queryFn: async ({ signal }) => {
          const result = await operation.call(
            parseEntityDetailInput(entity, input),
            { signal },
          );
          return result === null
            ? null
            : getEntityDetailOutputSchema(entity).parse(result);
        },
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
