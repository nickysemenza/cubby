import { useQuery, useQueryClient } from "@tanstack/react-query";

import { isBrowserRoutedEntity } from "~/entity/entities";
import { entityListHref } from "~/entity/entity-list-href";
import { entityMetadataQueryOptions } from "~/entity/metadata";
import { useProblemContinuation } from "~/entity/problems/problem-continuation";
import {
  WorkActionLink,
  type WorkActionProps,
} from "~/entity/work-queue/work-actions";

/**
 * `open-list`: an entity-grain Problem's reason group continues in its entity
 * list, with the Problem's own filters and sort and its full columns.
 * `worklist` is context only; the encoded filters remain the membership.
 */
export function OpenProblemListAction({ action, target }: WorkActionProps) {
  const queryClient = useQueryClient();
  const query = useProblemContinuation(
    target.scope === "group" ? target.reason : undefined,
  );
  const metadata = useQuery({
    ...entityMetadataQueryOptions(query?.source.entity ?? "product"),
    enabled: query !== undefined && query !== null,
  });
  if (metadata.error) throw metadata.error;
  if (!query || !metadata.data || !isBrowserRoutedEntity(query.source.entity))
    return null;
  return (
    <WorkActionLink
      action={action}
      href={entityListHref(
        queryClient,
        query.source.entity,
        { filters: query.source.filters, sort: query.source.sort },
        { worklist: query.key },
      )}
    />
  );
}
