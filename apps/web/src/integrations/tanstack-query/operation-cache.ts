import { connectedRecordsInputSchema } from "@cubby/schemas/connected-records";
import {
  entityReportInput,
  entityReportManyInput,
} from "@cubby/schemas/entity-report";
import { parseShortcode } from "@cubby/shared";
import type { Query, QueryClient } from "@tanstack/react-query";
import { z } from "zod";

import type { DatabaseChanges } from "~/lib/doorbell";

import {
  EMPTY_INVALIDATION_TAG_SET,
  combineRippleTags,
  entityRipple,
  type InvalidationTagSet,
} from "./cache-tags";
import type { OperationCacheTag } from "./operation-meta";

const tagMatches = (
  candidate: OperationCacheTag,
  invalidation: OperationCacheTag,
) =>
  invalidation.length <= candidate.length &&
  invalidation.every((part, index) => candidate[index] === part);

export const resolveInvalidationTags = (
  invalidates: InvalidationTagSet | undefined,
): InvalidationTagSet => invalidates ?? EMPTY_INVALIDATION_TAG_SET;

/**
 * The one predicate every tag-driven cache operation shares: a query matches
 * when any tag it declares is prefix-matched by any of the given tags.
 */
export const matchesTags =
  (invalidations: readonly OperationCacheTag[]) =>
  (query: Query): boolean =>
    (query.meta?.cacheTags ?? []).some((tag) =>
      invalidations.some((invalidation) => tagMatches(tag, invalidation)),
    );

export async function invalidateOperationTags(
  queryClient: QueryClient,
  invalidations: InvalidationTagSet,
  options?: { removeInactive?: boolean },
) {
  if (invalidations.length === 0) return;
  const predicate = matchesTags(invalidations);
  // Evict inactive baselines immediately; unrelated active refreshes cannot
  // hold navigation or a newly opened editor hostage.
  if (options?.removeInactive)
    queryClient.removeQueries({ predicate, type: "inactive" });
  await queryClient.invalidateQueries({ predicate });
}

export const cancelQueriesByTags = (
  queryClient: QueryClient,
  tags: readonly OperationCacheTag[],
): Promise<void> =>
  tags.length === 0
    ? Promise.resolve()
    : queryClient.cancelQueries({ predicate: matchesTags(tags) });

/** Subscription establishment/resume cannot know which hints were missed. */
export async function resyncOperationQueries(queryClient: QueryClient) {
  const predicate = (query: Query) => Boolean(query.meta?.cacheTags?.length);
  await queryClient.cancelQueries({ predicate });
  // Inactive queries can still own streamed markup awaiting hydration.
  // Preserve that baseline; mount and detail loaders refetch invalidated data.
  await queryClient.invalidateQueries({ predicate });
}

const operationKeyPayload = z.object({ input: z.unknown() });
const detailRecordInput = z.object({ shortcode: z.string() });

/** Only these reads belong to a single record; list/selection reports stay broad. */
function queryRecord(query: Query) {
  const payload = operationKeyPayload.safeParse(query.queryKey[2]);
  if (!payload.success) return null;
  const input = payload.data.input;
  let id: string | undefined;
  switch (query.meta?.operation) {
    case "entity.detail": {
      const parsed = detailRecordInput.safeParse(input);
      if (parsed.success) id = parsed.data.shortcode;
      break;
    }
    case "entityReport.get": {
      const parsed = entityReportInput.safeParse(input);
      if (parsed.success && parsed.data.scope.kind === "record")
        id = parsed.data.scope.id;
      break;
    }
    case "entityReport.getMany": {
      const parsed = entityReportManyInput.safeParse(input);
      if (parsed.success) id = parsed.data.id;
      break;
    }
    case "entityGraph.connectedRecords": {
      const parsed = connectedRecordsInputSchema.safeParse(input);
      if (parsed.success) id = parsed.data.source.entityId;
      break;
    }
  }
  return id ? parseShortcode(id) : null;
}

/** Narrow only the changed record's category; dependent categories retain their ripple. */
export function matchesDatabaseChanges(changes: DatabaseChanges) {
  const matches = matchesTags(
    combineRippleTags(...Object.keys(changes).map(entityRipple)),
  );
  return (query: Query): boolean => {
    const record = queryRecord(query);
    if (record) {
      const ids = changes[record.type];
      // Record reports share broad dependency tags; their own identity is authoritative.
      if (ids !== undefined)
        return ids === null || ids.includes(record.shortcode);
    }
    return matches(query);
  };
}

export async function invalidateDatabaseChanges(
  client: QueryClient,
  changes: DatabaseChanges,
) {
  const predicate = matchesDatabaseChanges(changes);
  await client.cancelQueries({ predicate });
  await client.invalidateQueries({ predicate });
}
