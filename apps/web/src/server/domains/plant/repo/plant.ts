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
import { and, eq, inArray } from "drizzle-orm";
import { uniq } from "es-toolkit";

import { householdLocalDate } from "~/lib/household-date";
import type { Database, DrizzleTransaction } from "~/server/db";
import type { IncomingEdgePolicy } from "~/server/db/entity-incoming-edges";
import {
  buildPartialUpdateValues,
  notDeleted,
  unwrapDb,
  withTransaction,
} from "~/server/db/helpers";
import { plant } from "~/server/db/schema";
import {
  guideWindowsFor,
  plantDisplayName,
  plantRoutesFor,
  resolveGardenGuideKey,
} from "~/server/domains/plant/repo/windows";
import {
  type MutationReceipt,
  defineMutationWriter,
} from "~/server/entity-kernel/repo/repository";
import { createEntityCrud } from "~/server/entity-kernel/repo/repository";
import { resolveNames } from "~/server/entity-kernel/resolve";
import { logAuditEntry } from "~/server/generic/audit-log/repo/audit-log";
import { listScaffold } from "~/server/generic/list/repo/list";
import type { ListProjection } from "~/server/generic/list/repo/list-contracts";
import {
  listReadPlan,
  type ListReadOptions,
} from "~/server/generic/list/repo/list-projection";
import { completeListReader } from "~/server/generic/list/repo/list-read-adapters";
import {
  finalizeMerge,
  mergeNotes,
  resolveMergeTargets,
} from "~/server/generic/merge/repo/core";
import { applyMergePolicy } from "~/server/generic/removal/repo/dispositions";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

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

const plantReadOptions = {
  references: {
    ingredientId: { kind: "lookup", name: "ingredientName", missing: "null" },
  },
  bindings: (bind) => [
    bind(plantOut.pick({ gardenGuideKey: true, displayName: true }), (row) => ({
      gardenGuideKey: resolveGardenGuideKey(row.gardenGuideKey),
      displayName: plantDisplayName(row.name, row.gardenGuideKey),
    })),
    bind(
      plantOut.pick({
        guideSowWindow: true,
        guideTransplantWindow: true,
        routes: true,
      }),
      (row) => {
        const key = resolveGardenGuideKey(row.gardenGuideKey);
        const windows = guideWindowsFor(key);
        return {
          guideSowWindow: windows.sow,
          guideTransplantWindow: windows.transplant,
          routes: plantRoutesFor(key, Number(householdLocalDate().slice(5, 7))),
        };
      },
    ),
  ],
} satisfies ListReadOptions<PlantRow>;
const plantRead = listReadPlan<PlantRow>("plant", plantReadOptions);
const hydrate = async (
  db: Database | DrizzleTransaction,
  rows: PlantRow[],
): Promise<PlantOut[]> =>
  (await plantRead.read(db, rows, { kind: "full" })).map((row) =>
    plantOut.parse(row),
  );

export const listPlantsRead = (
  db: Database,
  filters: PlantFilters,
  sorts: SortParams[],
  pagination: PaginationParams,
  projection: ListProjection = { kind: "full" },
) =>
  scaffold.read(
    db,
    { filters, sorts, pagination, projection },
    {
      read: plantReadOptions,
    },
  );

export const listPlants = completeListReader(plantOut, listPlantsRead);

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

export const createPlant = defineMutationWriter({
  entity: "plant",
  read: async (
    receipt: MutationReceipt<"plant">,
    db: Database,
    _data: PlantCreateInput,
    _actor: ActorContext,
  ) => ({
    output: await plantCrud.getByID(db, receipt.entityId),
    entityId: receipt.entityId,
  }),
  write: async (
    readOutput,
    db: Database,
    data: PlantCreateInput,
    actor: ActorContext,
  ) => {
    const id = await withTransaction(db, async (tx) =>
      insertPlant(
        tx,
        data,
        (await resolveIngredient(tx, data.ingredientId)) ?? null,
        actor,
      ),
    );
    return readOutput({ entityId: id });
  },
});

export const updatePlant = defineMutationWriter({
  entity: "plant",
  read: async (
    receipt: MutationReceipt<"plant">,
    db: Database,
    _shortcode: PlantShortcode,
    _data: PlantUpdateData,
    _actor: ActorContext,
  ) => ({
    output: await plantCrud.getByID(db, receipt.entityId),
    entityId: receipt.entityId,
  }),
  write: async (
    readOutput,
    db: Database,
    shortcode: PlantShortcode,
    data: PlantUpdateData,
    actor: ActorContext,
  ) => {
    const id = await resolveOrThrow(db, "plant", shortcode);
    return withTransaction(db, async (tx) => {
      const receipt = await plantCrud.update(
        tx,
        id,
        {
          ...data,
          ingredientId: await resolveIngredient(tx, data.ingredientId),
        },
        actor,
        async (_db, receipt) => receipt,
      );
      return readOutput(receipt, async () => ({
        output: await plantCrud.getByID(tx, id),
        entityId: id,
      }));
    });
  },
});

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
    const rows = await tx
      .select({ id: plant.id, notes: plant.notes })
      .from(plant)
      .where(inArray(plant.id, [keepId, ...loserIds]))
      .orderBy(plant.id)
      .for("update");
    const previousNotes = rows.find((row) => row.id === keepId)?.notes ?? null;
    const notes = mergeNotes(
      previousNotes,
      ...loserIds.map((id) => rows.find((row) => row.id === id)?.notes),
    );
    await tx.update(plant).set({ notes }).where(eq(plant.id, keepId));
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
      survivorChanges: {
        mergedFrom: { from: null, to: loserIds },
        ...(notes !== previousNotes
          ? { notes: { from: previousNotes, to: notes } }
          : {}),
      },
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
            ? ((
                await resolveNames(
                  tx,
                  "ingredient",
                  [{ name: wanted.ingredientName }],
                  { create: true, actor },
                )
              )[0]?.row?.id ?? null)
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
