import { isBrowserRoutedEntity } from "~/entity/entities";
import { entityListHref } from "~/entity/entity-list-href";
import { problemQuery } from "~/entity/problems/problem-registry";
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
  if (target.scope !== "group") return null;
  const query = problemQuery(target.reason);
  if (
    query?.source.kind !== "entity" ||
    query.continuation.kind !== "entity-list" ||
    !isBrowserRoutedEntity(query.source.entity)
  )
    return null;
  return (
    <WorkActionLink
      action={action}
      href={entityListHref(
        query.source.entity,
        { filters: query.source.filters, sort: query.source.sort },
        { worklist: query.key },
      )}
    />
  );
}
