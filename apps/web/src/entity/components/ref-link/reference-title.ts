import { entityRoster } from "@cubby/schemas/entity-roster";
import { queryOptions } from "@tanstack/react-query";
import { chunk } from "es-toolkit";
import { z } from "zod";

import { entityListFor } from "~/entity/entity-list";
import { listEntities, type ListEntity } from "~/entity/model/list-contracts";

export type ReferenceTitle = {
  title: string | null;
  emoji: string | null;
};

const REFERENCE_TITLE_CHUNK = 100;

export const isTitledReferenceEntity = (entity: string): entity is ListEntity =>
  listEntities.some((candidate) => candidate === entity);

const titleRow = z.looseObject({ id: z.string() });
const text = z.string().nullish();

type Waiter = {
  strong: boolean;
  resolve: (value: ReferenceTitle | null) => void;
  reject: (error: unknown) => void;
};

const metaByEntity = new Map<
  ListEntity,
  ReturnType<ReturnType<typeof entityListFor>["selectedListQueryPlan"]>["meta"]
>();
const pending = new Map<ListEntity, Map<string, Waiter[]>>();
let scheduled: ReturnType<typeof setTimeout> | undefined;

function titlePlan(entity: ListEntity, ids: readonly string[]) {
  const { titleField, recordEmojiField } = entityRoster[entity];
  const params = {
    filters: { ids: [...ids] },
    pagination: { pageIndex: 0, pageSize: ids.length },
    includeCount: false,
    fields: recordEmojiField ? [titleField, recordEmojiField] : [titleField],
  };
  // SAFETY: the ids filter and selected fields are parsed by the target's own
  // list schema before the read executes.
  return entityListFor(entity).selectedListQueryPlan(params as never);
}

async function readTitles(
  entity: ListEntity,
  ids: readonly string[],
  waiters: ReadonlyMap<string, readonly Waiter[]>,
) {
  const { titleField, recordEmojiField } = entityRoster[entity];
  try {
    const result = await titlePlan(entity, ids).execute(
      new AbortController().signal,
      ids.some((id) => waiters.get(id)?.some((waiter) => waiter.strong))
        ? "strong"
        : undefined,
    );
    const rows = new Map<string, z.infer<typeof titleRow>>();
    for (const item of result.items) {
      const row = titleRow.parse(item);
      rows.set(row.id, row);
    }
    for (const id of ids) {
      const row = rows.get(id);
      const value: ReferenceTitle | null = row
        ? {
            title: text.parse(row[titleField]) ?? null,
            emoji: recordEmojiField
              ? (text.parse(row[recordEmojiField]) ?? null)
              : null,
          }
        : null;
      for (const waiter of waiters.get(id) ?? []) waiter.resolve(value);
    }
  } catch (error) {
    for (const id of ids)
      for (const waiter of waiters.get(id) ?? []) waiter.reject(error);
  }
}

function flush() {
  scheduled = undefined;
  const taken = [...pending];
  pending.clear();
  for (const [entity, waiters] of taken)
    for (const ids of chunk([...waiters.keys()], REFERENCE_TITLE_CHUNK))
      void readTitles(entity, ids, waiters);
}

/** Links rendered in one commit share one selected-field read per entity. */
function loadReferenceTitle(
  entity: ListEntity,
  id: string,
  strong: boolean,
): Promise<ReferenceTitle | null> {
  return new Promise((resolve, reject) => {
    const waiters = pending.get(entity) ?? new Map<string, Waiter[]>();
    pending.set(entity, waiters);
    waiters.set(id, [...(waiters.get(id) ?? []), { strong, resolve, reject }]);
    scheduled ??= setTimeout(flush, 0);
  });
}

/**
 * The label a by-id reference link needs: the record's title and mark, not its
 * whole detail projection. Cache tags follow the entity's list reads, so a
 * change to the entity rereads its labels.
 */
export function referenceTitleQueryOptions(entity: ListEntity, id: string) {
  let meta = metaByEntity.get(entity);
  if (!meta) {
    meta = titlePlan(entity, [id]).meta;
    metaByEntity.set(entity, meta);
  }
  return queryOptions({
    queryKey: ["referenceTitle", entity, id] as const,
    queryFn: ({ client, queryKey }) =>
      loadReferenceTitle(
        entity,
        id,
        client.getQueryState(queryKey)?.isInvalidated === true,
      ),
    meta,
  });
}
