import type { DerivedBacklog } from "@cubby/schemas/derived-backlog";

type Entity = DerivedBacklog["kinds"][number]["entity"];

type BacklogMatrixRow = {
  entity: Entity;
  /** Declared fields only; an absent key means the entity has no such kind. */
  counts: ReadonlyMap<string, number>;
  total: number;
};

export type BacklogMatrix = {
  rows: BacklogMatrixRow[];
  fields: string[];
  fieldTotals: ReadonlyMap<string, number>;
  /** The largest single cell, the shared heat-scale max (every cell counts values). */
  max: number;
  attributed: number;
  /** Queued values whose target matches no current declaration. */
  unattributed: number;
};

/**
 * Entity x derived-field pivot. Rows keep declaration order; fields shared by
 * the most entities lead so common kinds line up in the leftmost columns.
 */
export function pivotDerivedBacklog(
  backlog: Pick<DerivedBacklog, "total" | "kinds">,
): BacklogMatrix {
  const rows = new Map<Entity, Map<string, number>>();
  const fieldTotals = new Map<string, number>();
  const fieldEntities = new Map<string, number>();
  for (const kind of backlog.kinds) {
    let counts = rows.get(kind.entity);
    if (!counts) rows.set(kind.entity, (counts = new Map()));
    counts.set(kind.field, kind.count);
    fieldTotals.set(
      kind.field,
      (fieldTotals.get(kind.field) ?? 0) + kind.count,
    );
    fieldEntities.set(kind.field, (fieldEntities.get(kind.field) ?? 0) + 1);
  }
  const firstSeen = [...fieldTotals.keys()];
  const fields = [...firstSeen].sort(
    (a, b) =>
      (fieldEntities.get(b) ?? 0) - (fieldEntities.get(a) ?? 0) ||
      firstSeen.indexOf(a) - firstSeen.indexOf(b),
  );
  const attributed = backlog.kinds.reduce((sum, kind) => sum + kind.count, 0);
  return {
    rows: [...rows].map(([entity, counts]) => ({
      entity,
      counts,
      total: [...counts.values()].reduce((sum, count) => sum + count, 0),
    })),
    fields,
    fieldTotals,
    max: Math.max(0, ...backlog.kinds.map((kind) => kind.count)),
    attributed,
    unattributed: Math.max(0, backlog.total - attributed),
  };
}
