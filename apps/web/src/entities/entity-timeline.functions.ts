import type { EntityTimelineOut } from "@cubby/schemas/entity-timeline";
import { queryOptions } from "@tanstack/react-query";

import { entityTimelineContract } from "~/contracts/entity-timeline.contract";
import {
  defineOperationDomain,
  type OperationQueryKey,
} from "~/integrations/tanstack-query/operation-catalog";

import {
  type EntityTimelineInputByEntity,
  type EntityTimelineParamsByEntity,
  entityTimelineInputFor,
  getEntityTimelineOutputSchema,
  parseEntityTimelineInput,
  type TimelineEntity,
} from "./generated/entity-timelines.gen";

/** @lintignore Discovered by the operation registry generator. */
export const entityTimeline = defineOperationDomain(entityTimelineContract, {
  timeline: {
    parse: (result, input) =>
      getEntityTimelineOutputSchema(input.entity).parse(result),
    tags: [["entity", "timeline"]],
  },
});

export type EntityTimelineParams<E extends TimelineEntity> =
  EntityTimelineParamsByEntity[E];
/** One entity's list filters as the timeline input accepts them. */
export type EntityTimelineFiltersByEntity = {
  [E in TimelineEntity]: EntityTimelineInputByEntity[E]["filters"];
};
/** One entity's window (`ids`/`from`/`to`/`order`) as the timeline input accepts it. */
export type EntityTimelineWindowByEntity = {
  [E in TimelineEntity]: EntityTimelineInputByEntity[E]["window"];
};

/**
 * Bind `entity.timeline` to one entity, so its filters, window, and cache key
 * all carry that entity's types. Throws for an entity the operation is not
 * registered for.
 */
export function entityTimelineFor<E extends TimelineEntity>(
  entity: E,
  descriptor: typeof entityTimeline.timeline = entityTimeline.timeline,
) {
  const operation = descriptor.forEntity(entity);
  const queryKeyFor = (
    input: EntityTimelineInputByEntity[E],
  ): OperationQueryKey<EntityTimelineInputByEntity[E]> => [
    "operation",
    operation.id,
    { entity, input },
  ];
  return {
    entity,
    queryKey: (input: EntityTimelineParams<E>) =>
      queryKeyFor(entityTimelineInputFor(entity, input)),
    queryOptions: (input: EntityTimelineParams<E>) => {
      const wireInput = entityTimelineInputFor(entity, input);
      const policy = operation.policy(wireInput);
      return queryOptions({
        queryKey: queryKeyFor(wireInput),
        queryFn: async ({ signal }): Promise<EntityTimelineOut> => {
          const result = await operation.call(
            parseEntityTimelineInput(entity, wireInput),
            { signal },
          );
          return getEntityTimelineOutputSchema(entity).parse(result);
        },
        meta: policy.meta,
        ...policy.freshness,
      });
    },
  };
}
