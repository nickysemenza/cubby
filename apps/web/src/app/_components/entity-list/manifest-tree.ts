import type { Entity } from "@cubby/schemas/entity";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import { entitySummary } from "@cubby/schemas/entity-summary";
import { z } from "zod";

import type {
  BaseListRow,
  EntityListTreeConfig,
} from "~/app/_components/hooks/useEntityList";

export type TreeRow<T> = T & { subRows?: TreeRow<T>[] };

/**
 * Nests flat rows under their parents, keeping the input's sibling order. A
 * row whose parent is not among `rows` (a search match, or a parent on a page
 * not yet loaded) becomes a root, so filtering never hides a match.
 */
export function nestByParent<T extends { id: string }>(
  rows: readonly T[],
  parentOf: (row: T) => string | null,
): TreeRow<T>[] {
  const nodes = new Map<string, TreeRow<T>>(
    rows.map((row) => [row.id, { ...row }]),
  );
  const roots: TreeRow<T>[] = [];
  for (const row of rows) {
    const node = nodes.get(row.id);
    if (!node) continue;
    const parentId = parentOf(row);
    const parent =
      parentId && parentId !== row.id ? nodes.get(parentId) : undefined;
    if (parent) (parent.subRows ??= []).push(node);
    else roots.push(node);
  }
  return roots;
}

const parentIdSchema = z.string().nullish();
const recordSchema = z.looseObject({});

const manifestTrees = new Map<
  Entity,
  EntityListTreeConfig<TreeRow<BaseListRow>, BaseListRow> | null
>();

/**
 * The tree an entity declares with `list.tree`, built from its parent
 * reference's read key. Cached per entity so the config stays referentially
 * stable, as `useEntityList` requires.
 */
export function manifestTree(
  entity: Entity,
): EntityListTreeConfig<TreeRow<BaseListRow>, BaseListRow> | null {
  const cached = manifestTrees.get(entity);
  if (cached !== undefined) return cached;
  const declared = entitySummary[entity].list.tree;
  const readKey = declared
    ? entityFieldModels[entity].fields.find(
        (field) => field.key === declared.parentField,
      )?.readKey
    : null;
  const config = readKey
    ? {
        nest: (rows: BaseListRow[]) =>
          nestByParent(
            rows,
            (row) =>
              parentIdSchema.parse(recordSchema.parse(row)[readKey]) ?? null,
          ),
        getSubRows: (row: TreeRow<BaseListRow>) => row.subRows,
        expandable: true,
      }
    : null;
  manifestTrees.set(entity, config);
  return config;
}
