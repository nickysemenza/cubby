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

import { projectListRows } from "~/entities/list-read-schema";
import type { Database, DrizzleTransaction } from "~/server/db";
import type { IncomingEdgePolicy } from "~/server/db/entity-incoming-edges";
import { ingredient, plant } from "~/server/db/schema";
import { resolveNames } from "~/server/entity-kernel/resolve";
import {
  guideWindowsFor,
  plantDisplayName,
  plantRoutesFor,
  resolveGardenGuideKey,
} from "~/server/garden-guides/windows";
import { logAuditEntry } from "~/server/repo/audit-log";
import { loadDataQualities } from "~/server/repo/data-quality";
import {
  buildPartialUpdateValues,
  notDeleted,
  unwrapDb,
  withTransaction,
} from "~/server/repo/database-helpers";
import { resolveOrCreateIngredients } from "~/server/repo/ingredient/crud";
import { listScaffold } from "~/server/repo/list";
import {
  loadListGroup,
  type ListProjection,
  type ListReadRow,
  wantsListGroup,
} from "~/server/repo/list-projection";
import { finalizeMerge, resolveMergeTargets } from "~/server/repo/merge";
import { applyMergePolicy } from "~/server/repo/removal";
import { createEntityCrud } from "~/server/repo/repository";
import {
  lookupEntityReferences,
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

type PlantRow = typeof plant.$inferSelect;

const scaffold = listScaffold("plant", plant);

const hydrateRead = async (
  db: Database | DrizzleTransaction,
  rows: PlantRow[],
  projection: ListProjection,
): Promise<ListReadRow[]> => {
  const [ingredients, qualities] = await Promise.all([
    loadListGroup(projection, "relations", () =>
      lookupEntityReferences(
        db,
        "ingredient",
        rows.map((row) => row.ingredientId),
      ),
    ),
    loadListGroup(projection, "quality", () =>
      loadDataQualities(
        db,
        "plant",
        rows.map((row) => row.id),
      ),
    ),
  ]);
  return projectListRows(
    "plant",
    rows.map((row) => {
      const key = resolveGardenGuideKey(row.gardenGuideKey);
      const linked = row.ingredientId
        ? ingredients?.get(row.ingredientId)
        : undefined;
      const windows = wantsListGroup(projection, "derived")
        ? guideWindowsFor(key)
        : undefined;
      const result = {
        ...row,
        id: parseShortcodeFor("plant", row.shortcode),
        gardenGuideKey: key,
        displayName: plantDisplayName(row.name, row.gardenGuideKey),
      };
      if (wantsListGroup(projection, "relations"))
        Object.assign(result, {
          ingredientId: linked?.id ?? null,
          ingredientName: linked?.name ?? null,
        });
      if (windows)
        Object.assign(result, {
          guideSowWindow: windows.sow,
          guideTransplantWindow: windows.transplant,
          routes: plantRoutesFor(key, new Date().getUTCMonth() + 1),
        });
      if (qualities)
        Object.assign(result, { dataQuality: qualities.get(row.id) });
      return result;
    }),
    projection,
  );
};

const hydrate = async (
  db: Database | DrizzleTransaction,
  rows: PlantRow[],
): Promise<PlantOut[]> =>
  (await hydrateRead(db, rows, { kind: "full" })).map((row) =>
    plantOut.parse(row),
  );

const buildWhere = (filters: PlantFilters) =>
  scaffold.where(filters, [
    filters.ingredientId === undefined
      ? undefined
      : sql`${plant.ingredientId} IN (
          SELECT ${ingredient.id} FROM ${ingredient}
          WHERE ${inArray(ingredient.shortcode, [filters.ingredientId].flat())}
        )`,
  ]);

export const listPlantsRead = (
  db: Database,
  filters: PlantFilters,
  sorts: SortParams[],
  pagination: PaginationParams,
  projection: ListProjection = { kind: "full" },
) =>
  scaffold.list(
    db,
    { filters, sorts, pagination, projection },
    {
      where: buildWhere(filters),
      hydrate: (rows, selected) => hydrateRead(db, rows, selected),
    },
  );

export const listPlants = async (
  db: Database,
  filters: PlantFilters,
  sorts: SortParams[],
  pagination: PaginationParams,
) => {
  const result = await listPlantsRead(db, filters, sorts, pagination, {
    kind: "full",
  });
  return { ...result, data: result.data.map((row) => plantOut.parse(row)) };
};

const fetchById = async (
  db: Database | DrizzleTransaction,
  id: PlantId,
): Promise<PlantRow | undefined> => {
  const [row] = await unwrapDb(db)
    .select()
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
  fromDB: async (db, row) => (await hydrate(db, [row]))[0]!,
  toUpdate: (data: PlantWrite) => buildPartialUpdateValues(data),
  auditUpdateFields: [...entityFieldModels.plant.audit],
});

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
    entityKind: "plant",
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
    const repointed = await applyMergePolicy(tx, {
      entity: "plant",
      policy: PLANT_MERGE_EDGE_POLICY,
      keepId,
      loserIds,
      liveOnly: false,
    });
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
        plantingEdgesRepointed: repointed["Planting.plantId"] ?? 0,
        productEdgesRepointed: repointed["Product.growsPlantId"] ?? 0,
      },
    };
  });
}

/**
 * Shim over the kernel `resolve` capability kept for the MCP tools; remove
 * once they call `resolveEntity`. Resolves each `{ name, gardenGuideKey?,
 * ingredientName? }` within its crop (any crop when none is given) and
 * creates the misses; `ingredientName` only fills a created Plant's
 * informational ingredient link, resolving or creating that Ingredient.
 */
export async function resolveOrCreatePlants(
  db: Database,
  input: ResolvePlantsInput,
  actor: ActorContext,
): Promise<ResolvePlantsOutput> {
  return withTransaction(db, async (tx) => {
    const resolved = await resolveNames(
      tx,
      "plant",
      input.plants.map((wanted) => ({
        name: wanted.name,
        where:
          wanted.gardenGuideKey === undefined
            ? undefined
            : { gardenGuideKey: wanted.gardenGuideKey },
        values: async () => ({
          gardenGuideKey: wanted.gardenGuideKey ?? null,
          ingredientId: wanted.ingredientName
            ? (await resolveOrCreateIngredients(tx, [wanted.ingredientName]))[0]
                ?.entityId
            : null,
        }),
      })),
      { create: true, actor },
    );
    return {
      plants: resolved.map(({ row }, index) => {
        if (!row) throw new Error("A creating resolve returned no plant");
        return {
          name: input.plants[index]?.name ?? row.name,
          id: parseShortcodeFor("plant", row.shortcode),
          created: row.created,
        };
      }),
    };
  });
}
