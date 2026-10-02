import {
  type DataQuality,
  type ScoredEntity,
  scoredEntities,
} from "@cubby/schemas/data-quality";
import type { DisplayImageSummary } from "@cubby/schemas/display-images";
import { parseEntityId } from "@cubby/schemas/identifiers";
import type { ListGroupSummary } from "@cubby/schemas/pagination";

import type { ListEntity } from "~/entity/generated/entity-lists.gen";
import { projectListRows } from "~/entity/list-read-schema";
import type { Database, DrizzleTransaction } from "~/server/db";

import { loadDataQualities } from "./data-quality/hydrate";
import {
  resolveEntityDisplayImageLists,
  withDisplayImages,
} from "./entity-display-image";
import { traceListGroup } from "./list-read-tracing";

export type ListReadRow = ReturnType<typeof projectListRows>[number];

export interface ListReadPage<T = ListReadRow> {
  data: T[];
  count: number;
  sums?: Record<string, number>;
  groups?: ListGroupSummary[];
}

export type ListEnrichmentGroup = "quality" | "media" | "relations" | "derived";

export interface ListProjection {
  kind: "full" | "base" | "enrichment";
  groups?: readonly ListEnrichmentGroup[];
}

export const wantsListGroup = (
  projection: ListProjection,
  group: ListEnrichmentGroup,
): boolean =>
  projection.kind === "full" ||
  (projection.kind === "enrichment" &&
    projection.groups?.includes(group) === true);

/** A dependency shared by several groups is one loader, gated by its consumers. */
export const loadListGroup = async <T>(
  projection: ListProjection,
  groups: ListEnrichmentGroup | readonly ListEnrichmentGroup[],
  load: () => Promise<T>,
): Promise<T | undefined> =>
  [groups].flat().some((group) => wantsListGroup(projection, group))
    ? traceListGroup(groups, load)
    : undefined;

/** Build only the selected group's columns or canonical fields; omitted groups stay absent. */
export const listGroupFields = <T extends object>(
  projection: ListProjection,
  groups: ListEnrichmentGroup | readonly ListEnrichmentGroup[],
  build: () => T,
): Partial<T> => {
  if ([groups].flat().some((group) => wantsListGroup(projection, group)))
    return build();
  return {};
};

const scored = new Set<string>(scoredEntities);
const isScored = (entity: string): entity is ScoredEntity => scored.has(entity);

/** Domain loaders stay explicit; quality runs alongside them before mapping. */
export async function hydrateListRead<Row extends { id: string }, Loaded>(
  db: Database | DrizzleTransaction,
  entity: ListEntity,
  rows: readonly Row[],
  projection: ListProjection,
  options: {
    media?: boolean;
    load: () => Promise<Loaded>;
    mapRow: (
      row: Row,
      context: {
        loaded: Loaded;
        quality: DataQuality | undefined;
        displayImages: DisplayImageSummary[];
      },
    ) => ListReadRow;
  },
): Promise<ListReadRow[]> {
  const media = options.media && wantsListGroup(projection, "media");
  const [qualities, loaded, displayLists] = await Promise.all([
    isScored(entity)
      ? loadListGroup(projection, "quality", () =>
          loadDataQualities(
            db,
            entity,
            rows.map((row) => parseEntityId(entity, row.id)),
          ),
        )
      : undefined,
    options.load(),
    media
      ? traceListGroup("media", () =>
          resolveEntityDisplayImageLists(
            db,
            rows.map((row) => ({ entityKind: entity, entityId: row.id })),
          ),
        )
      : undefined,
  ]);
  const qualityById: ReadonlyMap<string, DataQuality> | undefined = qualities;
  const mapRow = (row: Row, displayImages: DisplayImageSummary[] = []) => {
    const quality = qualityById?.get(row.id);
    const value = options.mapRow(row, { loaded, quality, displayImages });
    return qualities ? { ...value, dataQuality: quality } : value;
  };
  const mapped = media
    ? await withDisplayImages(db, entity, rows, mapRow, displayLists)
    : rows.map((row) => mapRow(row));
  return projectListRows(entity, mapped, projection);
}

/** Dependencies precede consumers, even when several consumers share them. */
export function expandListGroups(
  groups: readonly ListEnrichmentGroup[],
  dependencies: Partial<
    Record<ListEnrichmentGroup, readonly ListEnrichmentGroup[]>
  >,
): ListEnrichmentGroup[] {
  const ordered: ListEnrichmentGroup[] = [];
  const visited = new Set<ListEnrichmentGroup>();
  const active = new Set<ListEnrichmentGroup>();
  const visit = (group: ListEnrichmentGroup) => {
    if (active.has(group))
      throw new Error(`List loader dependency cycle: ${group}`);
    if (visited.has(group)) return;
    active.add(group);
    for (const dependency of dependencies[group] ?? []) visit(dependency);
    active.delete(group);
    visited.add(group);
    ordered.push(group);
  };
  for (const group of groups) visit(group);
  return ordered;
}
