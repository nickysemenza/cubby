import type { ActorContext } from "@cubby/schemas/context";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import type { OperationDisposition } from "@cubby/schemas/entity-integrity";
import type {
  IngredientId,
  PlantId,
  PlantShortcode,
} from "@cubby/schemas/identifiers";
import { parseEntityId, parseShortcodeFor } from "@cubby/schemas/identifiers";
import type { PaginationParams, SortParams } from "@cubby/schemas/pagination";
import {
  type PlantCreateInput,
  type PlantFilters,
  type PlantOut,
  type PlantUpdateData,
  type ResolvePlantsInput,
  type ResolvePlantsOutput,
  plantOut,
} from "@cubby/schemas/plant";
import { and, eq, inArray, sql } from "drizzle-orm";
import { uniq } from "es-toolkit";

import type { Database, DrizzleTransaction } from "~/server/db";
import type { IncomingEdgePolicy } from "~/server/db/entity-incoming-edges";
import { ingredient, plant, planting, product } from "~/server/db/schema";
import {
  guideWindowsFor,
  plantDisplayName,
  plantRoutesFor,
  resolveGardenGuideKey,
} from "~/server/garden-guides/windows";
import { logAuditEntry } from "~/server/repo/audit-log";
import { loadDataQualities } from "~/server/repo/data-quality";
import {
  assertNoDependents,
  auditDateWhereConditions,
  buildPartialUpdateValues,
  countWhere,
  executeListQueryWithCount,
  getDb,
  notDeleted,
  unwrapDb,
  withTransaction,
} from "~/server/repo/database-helpers";
import { createEntityCrud } from "~/server/repo/entity-crud-factory";
import { countByTarget } from "~/server/repo/impact";
import { resolveOrCreateIngredients } from "~/server/repo/ingredient/crud";
import { listScaffold } from "~/server/repo/list-scaffold";
import {
  finalizeMerge,
  repointEdge,
  resolveMergeTargets,
} from "~/server/repo/merge";
import { removeEntity } from "~/server/repo/removal";
import {
  resolveAllOrThrow,
  resolveOrThrow,
} from "~/server/repo/shortcode-resolver";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

/** A plant keeps its garden history and seed stock; both block a delete. */
export const PLANT_DELETE_EDGE_POLICY = {
  "Planting.plantId": {
    code: "block-live-planting",
    effect: "block",
    description: "A plant grown by a live planting cannot be deleted.",
  },
  "Product.growsPlantId": {
    code: "block-live-garden-source-product",
    effect: "block",
    description:
      "A plant named by a live seed or plant product cannot be deleted.",
  },
} as const satisfies IncomingEdgePolicy<"plant", OperationDisposition>;

export const PLANT_MERGE_EDGE_POLICY = {
  "Planting.plantId": {
    code: "repoint-to-survivor",
    effect: "repoint",
    description: "Plantings of a merged plant move to the surviving plant.",
  },
  "Product.growsPlantId": {
    code: "repoint-to-survivor",
    effect: "repoint",
    description: "Seed and plant products move to the surviving plant.",
  },
} as const satisfies IncomingEdgePolicy<"plant", OperationDisposition>;

const columns = {
  id: plant.id,
  shortcode: plant.shortcode,
  name: plant.name,
  gardenGuideKey: plant.gardenGuideKey,
  verdict: plant.verdict,
  ingredientId: plant.ingredientId,
  latinName: plant.latinName,
  breeding: plant.breeding,
  daysFromSowMin: plant.daysFromSowMin,
  daysFromSowMax: plant.daysFromSowMax,
  daysFromTransplantMin: plant.daysFromTransplantMin,
  daysFromTransplantMax: plant.daysFromTransplantMax,
  notes: plant.notes,
  createdAt: plant.createdAt,
  updatedAt: plant.updatedAt,
} as const;

type PlantRow = {
  [K in keyof typeof columns]: (typeof plant.$inferSelect)[K];
};

const scaffold = listScaffold("plant", plant);

const toOut = async (
  db: Database | DrizzleTransaction,
  row: PlantRow,
): Promise<PlantOut> => {
  const ingredientRow = row.ingredientId
    ? await unwrapDb(db).query.ingredient.findFirst({
        where: and(eq(ingredient.id, row.ingredientId), notDeleted(ingredient)),
        columns: { shortcode: true, name: true },
      })
    : undefined;
  const key = resolveGardenGuideKey(row.gardenGuideKey);
  const windows = guideWindowsFor(key);
  const dataQuality = (await loadDataQualities(db, "plant", [row.id])).get(
    row.id,
  )!;
  return plantOut.parse({
    ...row,
    id: parseShortcodeFor("plant", row.shortcode),
    gardenGuideKey: key,
    ingredientId: ingredientRow
      ? parseShortcodeFor("ingredient", ingredientRow.shortcode)
      : null,
    ingredientName: ingredientRow?.name ?? null,
    displayName: plantDisplayName(row.name, row.gardenGuideKey),
    guideSowWindow: windows.sow,
    guideTransplantWindow: windows.transplant,
    routes: plantRoutesFor(key, new Date().getUTCMonth() + 1),
    dataQuality,
  });
};

const buildWhere = (filters: PlantFilters) =>
  scaffold.where(filters, [
    ...auditDateWhereConditions(plant, filters),
    filters.ingredientId === undefined
      ? undefined
      : sql`${plant.ingredientId} IN (
          SELECT ${ingredient.id} FROM ${ingredient}
          WHERE ${inArray(ingredient.shortcode, [filters.ingredientId].flat())}
        )`,
  ]);

export async function listPlants(
  db: Database,
  filters: PlantFilters,
  sorts: SortParams[],
  pagination: PaginationParams,
) {
  const where = buildWhere(filters);
  const { take, skip } = scaffold.page(pagination);
  const { data, count } = await executeListQueryWithCount(
    getDb(db)
      .select(columns)
      .from(plant)
      .where(where)
      .orderBy(...scaffold.orderBy(sorts, {}, filters))
      .limit(take)
      .offset(skip),
    countWhere(db, plant, where),
  );
  return { data: await Promise.all(data.map((row) => toOut(db, row))), count };
}

const fetchById = async (
  db: Database | DrizzleTransaction,
  id: PlantId,
): Promise<PlantRow | undefined> => {
  const [row] = await unwrapDb(db)
    .select(columns)
    .from(plant)
    .where(and(eq(plant.id, id), notDeleted(plant)))
    .limit(1);
  return row;
};

type PlantWrite = Omit<Partial<PlantUpdateData>, "ingredientId"> & {
  ingredientId?: IngredientId | null;
};

const plantCrud = createEntityCrud({
  table: plant,
  entity: "plant",
  fetchById,
  fromDB: (db, row) => toOut(db, row),
  toUpdate: (data: PlantWrite) => buildPartialUpdateValues(data),
  auditUpdateFields: [...entityFieldModels.plant.audit],
});

export const getPlantByID = plantCrud.getByID;
export const getPlantByShortcode = plantCrud.getByShortcode;

const resolveIngredient = async (
  db: Database | DrizzleTransaction,
  code: PlantUpdateData["ingredientId"],
): Promise<IngredientId | null | undefined> =>
  code === undefined
    ? undefined
    : code === null
      ? null
      : resolveOrThrow(db, "ingredient", code);

const insertPlant = async (
  tx: DrizzleTransaction,
  data: PlantCreateInput,
  ingredientId: IngredientId | null,
  actor: ActorContext,
): Promise<PlantId> => {
  const row = await insertWithShortcode(tx, "plant", {
    ...data,
    name: data.name.trim(),
    ingredientId,
  });
  await logAuditEntry(tx, actor, {
    entityType: "plant",
    entityId: row.id,
    action: "create",
  });
  return parseEntityId("plant", row.id);
};

export async function createPlant(
  db: Database,
  data: PlantCreateInput,
  actor: ActorContext,
): Promise<{ output: PlantOut; entityId: PlantId }> {
  const id = await withTransaction(db, async (tx) =>
    insertPlant(
      tx,
      data,
      (await resolveIngredient(tx, data.ingredientId)) ?? null,
      actor,
    ),
  );
  return { output: await plantCrud.getByID(db, id), entityId: id };
}

export async function updatePlant(
  db: Database,
  shortcode: PlantShortcode,
  data: PlantUpdateData,
  actor: ActorContext,
): Promise<{ output: PlantOut; entityId: PlantId }> {
  const id = await resolveOrThrow(db, "plant", shortcode);
  return withTransaction(db, async (tx) => {
    const output = await plantCrud.update(
      tx,
      id,
      { ...data, ingredientId: await resolveIngredient(tx, data.ingredientId) },
      actor,
    );
    return { output, entityId: id };
  });
}

export async function deletePlants(
  db: Database,
  shortcodes: PlantShortcode[],
  actor: ActorContext,
) {
  const ids = uniq(await resolveAllOrThrow(db, "plant", shortcodes));
  return withTransaction(db, async (tx) => {
    const fetchNames = (failedIds: PlantId[]) =>
      tx.query.plant.findMany({
        where: inArray(plant.id, failedIds),
        columns: { name: true },
      });
    // PLANT_DELETE_EDGE_POLICY declares both edges `block`; nothing generic
    // enforces `block`, so the repository must.
    const [plantings, products] = await Promise.all([
      countByTarget(tx, planting, planting.plantId, ids),
      countByTarget(tx, product, product.growsPlantId, ids),
    ]);
    await assertNoDependents({
      offendingParentIds: ids.filter((id) => plantings[id]),
      fetchNames,
      reason: "PLANT_HAS_PLANTINGS",
      message: (count, names) =>
        `Cannot delete ${count} plant(s): ${names} are grown by a planting.`,
    });
    await assertNoDependents({
      offendingParentIds: ids.filter((id) => products[id]),
      fetchNames,
      reason: "PLANT_HAS_PRODUCTS",
      message: (count, names) =>
        `Cannot delete ${count} plant(s): ${names} are named by a seed or plant product.`,
    });
    return removeEntity(tx, { entity: "plant", ids, removal: "soft", actor });
  });
}

export async function mergePlants(
  db: Database,
  input: { keepId: PlantShortcode; mergeIds: PlantShortcode[] },
  actor: ActorContext,
) {
  const { keepId, loserIds } = await resolveMergeTargets(db, {
    entity: "plant",
    ...input,
  });
  return withTransaction(db, async (tx) => {
    const plantingEdgesRepointed = (
      await repointEdge(tx, "plant", "Planting.plantId", {
        from: loserIds,
        to: keepId,
        liveOnly: false,
      })
    ).length;
    const productEdgesRepointed = (
      await repointEdge(tx, "plant", "Product.growsPlantId", {
        from: loserIds,
        to: keepId,
        liveOnly: false,
      })
    ).length;
    const { removed } = await finalizeMerge(tx, {
      entity: "plant",
      table: plant,
      keepId,
      loserIds,
      removal: "soft",
      actor,
      survivorChanges: { mergedFrom: { from: null, to: loserIds } },
    });
    return {
      mergeSummary: {
        deletedIds: uniq(input.mergeIds),
        merged: removed,
        plantingEdgesRepointed,
        productEdgesRepointed,
      },
    };
  });
}

/**
 * Resolve each `{ name, gardenGuideKey?, ingredientName? }` to a live Plant,
 * matching `name` case-insensitively within the crop (any crop when none is
 * given), and create the misses. `ingredientName` only fills the informational
 * ingredient link of a created Plant, resolving or creating that Ingredient.
 */
export async function resolveOrCreatePlants(
  db: Database,
  input: ResolvePlantsInput,
  actor: ActorContext,
): Promise<ResolvePlantsOutput> {
  return withTransaction(db, async (tx) => {
    const results: ResolvePlantsOutput["plants"] = [];
    for (const wanted of input.plants) {
      const [match] = await tx
        .select({ shortcode: plant.shortcode })
        .from(plant)
        .where(
          and(
            notDeleted(plant),
            sql`lower(${plant.name}) = lower(${wanted.name})`,
            wanted.gardenGuideKey === undefined
              ? undefined
              : eq(plant.gardenGuideKey, wanted.gardenGuideKey),
          ),
        )
        .orderBy(plant.createdAt)
        .limit(1);
      if (match) {
        results.push({
          name: wanted.name,
          id: parseShortcodeFor("plant", match.shortcode),
          created: false,
        });
        continue;
      }
      const ingredientId = wanted.ingredientName
        ? await resolveIngredientName(tx, wanted.ingredientName)
        : null;
      const id = await insertPlant(
        tx,
        {
          name: wanted.name,
          gardenGuideKey: wanted.gardenGuideKey ?? null,
          verdict: null,
          ingredientId: null,
          latinName: null,
          breeding: null,
          daysFromSowMin: null,
          daysFromSowMax: null,
          daysFromTransplantMin: null,
          daysFromTransplantMax: null,
          notes: null,
        },
        ingredientId,
        actor,
      );
      const created = await fetchById(tx, id);
      results.push({
        name: wanted.name,
        id: parseShortcodeFor("plant", created!.shortcode),
        created: true,
      });
    }
    return { plants: results };
  });
}

const resolveIngredientName = async (
  tx: DrizzleTransaction,
  name: string,
): Promise<IngredientId> => {
  const [resolved] = await resolveOrCreateIngredients(tx, [name]);
  return resolved!.entityId;
};
