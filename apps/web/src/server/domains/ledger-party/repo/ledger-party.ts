import type { ActorContext } from "@cubby/schemas/context";
import {
  type LedgerPartyCreateInput,
  type LedgerPartyUpdateData,
} from "@cubby/schemas/entities/ledgerParty";
import { ledgerPartyRawOut as rawLedgerPartyOut } from "@cubby/schemas/entity-contracts/ledgerParty";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import type {
  LedgerPartyId,
  LedgerPartyShortcode,
} from "@cubby/schemas/identifiers";
import { ENTITY_NOT_FOUND_REASON } from "@cubby/schemas/identifiers";
import { type MealFoodAmount } from "@cubby/schemas/meal";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { uniq } from "es-toolkit";

import { ledgerPartyRepositoryReadSchema } from "~/entity/generated/entity-schema-bindings.ledgerParty.gen";
import type { Database, DrizzleTransaction } from "~/server/db";
import { DECLARED_EDGE_MERGE_POLICIES } from "~/server/db/generated/declared-edges.gen";
import { DECLARED_EDGE_DELETE_POLICIES } from "~/server/db/generated/declared-edges.gen";
import {
  DECLARED_EDGE_DELETE_HOOKS,
  DECLARED_EDGE_MERGE_HOOKS,
} from "~/server/db/generated/declared-edges.gen";
import {
  uuidArrayParam,
  amountJsonSql,
  amountToColumns,
  buildPartialUpdateValues,
  notDeleted,
  unwrapDb,
  withTransaction,
} from "~/server/db/helpers";
import { relationalSql } from "~/server/db/helpers/relational-sql";
import {
  expenseAttribution,
  financialAccount,
  inventoryEntry,
  ledgerParty,
  meal,
  mealRecipe,
  mealRecipePortion,
  project,
  purchase,
  task,
} from "~/server/db/schema";
import { insertPurchaseEventRows } from "~/server/domains/financial-transaction/repo/purchase-event-mutations";
import { applyInventoryOwnershipInTransaction } from "~/server/domains/inventory/repo/ownership-mutations";
import {
  type MutationReceipt,
  defineMutationWriter,
} from "~/server/entity-kernel/repo/repository";
import { createEntityCrud } from "~/server/entity-kernel/repo/repository";
import { createAppError } from "~/server/errors/app-error";
import { ENTITY_STORED_WRITES } from "~/server/generated/entity-write-bindings.gen";
import { logAuditEntry } from "~/server/generic/audit-log/repo/audit-log";
import { listScaffold } from "~/server/generic/list/repo/list";
import {
  finalizeMerge,
  mergeNotes,
  resolveMergeTargets,
} from "~/server/generic/merge/repo/core";
import {
  applyMergePolicy,
  policyDelete,
} from "~/server/generic/removal/repo/dispositions";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import { enterWriteTransaction } from "~/server/kernel/gate";

export const ledgerPartyScaffold = listScaffold("ledgerParty", ledgerParty, {
  readSchema: ledgerPartyRepositoryReadSchema,
  read: { optionKind: ledgerParty.kind },
});

/**
 * Locks the row, then refuses the kind transitions the stored state forbids.
 * Runs before the crud reads its before-state so the check and the write see
 * the same row.
 */
const assertNoAccountHistory = async (
  tx: Database | DrizzleTransaction,
  ids: LedgerPartyId[],
) => {
  const result = await unwrapDb(tx).execute(
    sql`
    SELECT fa.shortcode FROM "FinancialAccount" fa
    JOIN "LedgerParty" party ON party.id = ANY(${uuidArrayParam(ids)})
    WHERE ${notDeleted("fa")} AND (
      fa."authorizedUsers" @> jsonb_build_array(jsonb_build_object('ledgerPartyId', party.shortcode)) OR
      fa."fundingPeriods" @> jsonb_build_array(jsonb_build_object('ledgerPartyId', party.shortcode))
    ) LIMIT 1
  `,
    "objects",
  );
  if (result.length)
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "Reconcile financial-account user/funding history before deleting, merging, or changing this party's kind.",
    );
};

const assertKindTransition = async (
  tx: Database | DrizzleTransaction,
  id: LedgerPartyId,
  data: LedgerPartyUpdateData,
) => {
  const [before] = await unwrapDb(tx)
    .select()
    .from(ledgerParty)
    .where(and(eq(ledgerParty.id, id), notDeleted(ledgerParty)))
    .for("update")
    .limit(1);
  if (!before)
    throw createAppError(
      ENTITY_NOT_FOUND_REASON.ledgerParty,
      `Ledger party not found: ${id}`,
    );
  if (
    data.kind !== undefined &&
    (before.kind === "household" || data.kind === "household") &&
    data.kind !== before.kind
  ) {
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "The singleton household ledger party cannot change kind.",
    );
  }
  if (data.kind !== undefined && data.kind !== before.kind) {
    await assertNoAccountHistory(tx, [id]);
    const [purchaser] = await unwrapDb(tx)
      .select({ id: purchase.id })
      .from(purchase)
      .where(and(eq(purchase.purchaserOverrideId, id), notDeleted(purchase)))
      .limit(1);
    if (purchaser)
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        "An explicit purchaser cannot change kind while referenced by a live Purchase.",
      );
    const [card] = await unwrapDb(tx)
      .select({ id: financialAccount.id })
      .from(financialAccount)
      .where(
        and(
          eq(financialAccount.primaryCardholderId, id),
          notDeleted(financialAccount),
        ),
      )
      .limit(1);
    if (card)
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        "A primary cardholder cannot change kind while referenced by a live card.",
      );
  }
  if (
    data.kind !== undefined &&
    data.kind !== "member" &&
    before.kind === "member"
  ) {
    const assignments = await unwrapDb(tx)
      .select({ id: task.id })
      .from(task)
      .where(and(eq(task.assigneeId, id), notDeleted(task)))
      .limit(1);
    const defaults = await unwrapDb(tx)
      .select({ id: project.id })
      .from(project)
      .where(and(eq(project.assigneeId, id), notDeleted(project)))
      .limit(1);
    if (assignments.length || defaults.length)
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        "A member assigned to live work cannot change kind.",
      );
  }
  if (before.kind !== "guest" && data.kind === "guest") {
    const [mappedAccount] = await unwrapDb(tx)
      .select({ id: financialAccount.id })
      .from(financialAccount)
      .where(
        and(
          eq(financialAccount.ledgerPartyId, id),
          notDeleted(financialAccount),
        ),
      )
      .limit(1);
    if (mappedAccount)
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        "A ledger party mapped by a live financial account cannot become a guest.",
      );
  }
};

const reader = createEntityCrud({
  entity: "ledgerParty",
  table: ledgerParty,
  scaffold: ledgerPartyScaffold,
  output: rawLedgerPartyOut,
  prepare: assertKindTransition,
  toUpdate: (data: LedgerPartyUpdateData) => buildPartialUpdateValues(data),
  auditUpdateFields: [...entityFieldModels.ledgerParty.audit],
});

/** One live Ledger Party by public code, or null. */
export const readLedgerParty = reader.getByShortcode;

export const createLedgerParty = defineMutationWriter({
  entity: "ledgerParty",
  read: async (
    receipt: MutationReceipt<"ledgerParty">,
    db: Database,
    _data: LedgerPartyCreateInput,
    _actor: ActorContext,
  ) => ({
    output: await reader.getByID(db, receipt.entityId),
    entityId: receipt.entityId,
  }),
  write: async (
    readOutput,
    db: Database,
    data: LedgerPartyCreateInput,
    actor: ActorContext,
  ) => {
    const id = await withTransaction(db, async (tx) => {
      await enterWriteTransaction(tx, { lane: "money", mode: "member" });
      if (data.kind === "household") {
        const [existing] = await tx
          .select({ id: ledgerParty.id })
          .from(ledgerParty)
          .where(
            and(eq(ledgerParty.kind, "household"), notDeleted(ledgerParty)),
          )
          .limit(1);
        if (existing)
          throw createAppError(
            "CONSTRAINT_VIOLATION",
            "Only one household ledger party may exist.",
          );
      }
      const created = await insertWithShortcode(tx, "ledgerParty", data);
      await logAuditEntry(tx, actor, {
        entityKind: "ledgerParty",
        entityId: created.id,
        action: "create",
      });
      return created.id;
    });
    return readOutput({ entityId: id });
  },
});

export const updateLedgerParty = reader.updateWriter(
  ENTITY_STORED_WRITES.ledgerParty.update,
  (output, entityId) => ({ output, entityId }),
);

const refuseHouseholdParty = async (
  tx: DrizzleTransaction,
  ids: LedgerPartyId[],
) => {
  const [household] = await tx
    .select({ id: ledgerParty.id })
    .from(ledgerParty)
    .where(and(inArray(ledgerParty.id, ids), eq(ledgerParty.kind, "household")))
    .limit(1);
  if (household)
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "The singleton household ledger party cannot be deleted.",
    );
};

export const deleteLedgerParties = policyDelete(
  "ledgerParty",
  DECLARED_EDGE_DELETE_POLICIES.ledgerParty,
  DECLARED_EDGE_DELETE_HOOKS.ledgerParty,
);

const lockMealRecipePortionReferences = async (
  tx: DrizzleTransaction,
  partyIds: LedgerPartyId[],
) => {
  const sources = await tx
    .select({
      mealId: mealRecipePortion.mealId,
      mealRecipeId: mealRecipePortion.mealRecipeId,
    })
    .from(mealRecipePortion)
    .where(
      and(
        inArray(mealRecipePortion.ledgerPartyId, partyIds),
        notDeleted(mealRecipePortion),
      ),
    );
  const targetMealIds = uniq(sources.map((portion) => portion.mealId)).sort();
  const lockedMeals =
    targetMealIds.length === 0
      ? []
      : await tx
          .select({ id: meal.id })
          .from(meal)
          .where(and(inArray(meal.id, targetMealIds), notDeleted(meal)))
          .orderBy(meal.id)
          .for("key share");
  if (lockedMeals.length !== targetMealIds.length)
    throw createAppError(
      "MEAL_NOT_FOUND",
      "A meal targeted by a portion is no longer live.",
    );
  const mealRecipeIds = uniq(
    sources.map((portion) => portion.mealRecipeId),
  ).sort();
  if (mealRecipeIds.length > 0)
    await tx
      .select({ id: mealRecipe.id })
      .from(mealRecipe)
      .where(inArray(mealRecipe.id, mealRecipeIds))
      .orderBy(mealRecipe.id)
      .for("update");
};

const foldMealRecipePortions = async (
  tx: DrizzleTransaction,
  keepId: LedgerPartyId,
  loserIds: LedgerPartyId[],
) => {
  const partyIds = [keepId, ...loserIds];
  const portions = await tx
    .select({
      mealRecipeId: mealRecipePortion.mealRecipeId,
      mealId: mealRecipePortion.mealId,
      ledgerPartyId: mealRecipePortion.ledgerPartyId,
      amount: amountJsonSql(
        mealRecipePortion.amountValue,
        mealRecipePortion.amountUnit,
      ),
      confirmedAt: mealRecipePortion.confirmedAt,
    })
    .from(mealRecipePortion)
    .where(
      and(
        inArray(mealRecipePortion.ledgerPartyId, partyIds),
        notDeleted(mealRecipePortion),
      ),
    )
    .orderBy(mealRecipePortion.id)
    .for("update");
  const groups = new Map<string, typeof portions>();
  for (const portion of portions) {
    const key = `${portion.mealRecipeId}:${portion.mealId}`;
    const group = groups.get(key);
    if (group) group.push(portion);
    else groups.set(key, [portion]);
  }
  const foldedAmounts = new Map<string, MealFoodAmount>();
  for (const [key, group] of groups) {
    const presentAmounts = group.map((portion) => portion.amount);
    const units = new Set(presentAmounts.map((amount) => amount.unit));
    if (units.size !== 1)
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        "Meal portions for the same preparation and meal use different units; reconcile the portion units before merging ledger parties.",
      );
    const value = presentAmounts.reduce(
      (total, amount) => total + amount.value,
      0,
    );
    if (!Number.isFinite(value))
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        "Merged meal portion amount is outside the supported numeric range.",
      );
    foldedAmounts.set(key, { value, unit: presentAmounts[0]!.unit });
  }
  if (portions.length === 0) return 0;
  await tx
    .update(mealRecipePortion)
    .set({ deletedAt: new Date() })
    .where(
      and(
        inArray(mealRecipePortion.ledgerPartyId, partyIds),
        notDeleted(mealRecipePortion),
      ),
    );
  for (const [key, group] of groups) {
    const first = group[0]!;
    const allConfirmed = group.every((portion) => portion.confirmedAt != null);
    await tx.insert(mealRecipePortion).values({
      mealRecipeId: first.mealRecipeId,
      mealId: first.mealId,
      ledgerPartyId: keepId,
      ...amountToColumns(foldedAmounts.get(key)!),
      confirmedAt: allConfirmed
        ? new Date(
            Math.max(...group.map((portion) => portion.confirmedAt!.getTime())),
          )
        : null,
    });
  }
  return portions.filter((portion) => portion.ledgerPartyId !== keepId).length;
};

export async function mergeLedgerParties(
  db: Database,
  input: { keepId: LedgerPartyShortcode; mergeIds: LedgerPartyShortcode[] },
  actor: ActorContext,
) {
  const { keepId, loserIds } = await resolveMergeTargets(db, {
    entity: "ledgerParty",
    ...input,
  });
  let merged = 0;
  let attributionEdgesRepointed = 0;
  let accountEdgesRepointed = 0;
  let inventoryEdgesRepointed = 0;
  let transferEdgesRepointed = 0;
  let portionEdgesRepointed = 0;
  let foodEntryEdgesRepointed = 0;
  let deviceEdgesRepointed = 0;
  await withTransaction(db, async (tx) => {
    await enterWriteTransaction(tx, { lane: "money", mode: "member" });
    const parties = await tx
      .select()
      .from(ledgerParty)
      .where(
        and(
          inArray(ledgerParty.id, [keepId, ...loserIds]),
          notDeleted(ledgerParty),
        ),
      )
      .orderBy(ledgerParty.id)
      .for("update");
    if (
      parties.length !== loserIds.length + 1 ||
      parties.some((party) => party.kind === "household") ||
      new Set(parties.map((party) => party.kind)).size !== 1
    )
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        "Only ledger parties of one non-household kind can be merged.",
      );
    await assertNoAccountHistory(tx, [keepId, ...loserIds]);
    const previousNotes =
      parties.find((party) => party.id === keepId)?.notes ?? null;
    const notes = mergeNotes(
      previousNotes,
      ...loserIds.map((id) => parties.find((party) => party.id === id)?.notes),
    );
    await tx
      .update(ledgerParty)
      .set({ notes })
      .where(eq(ledgerParty.id, keepId));
    const repointed = await applyMergePolicy(tx, {
      entity: "ledgerParty",
      policy: DECLARED_EDGE_MERGE_POLICIES.ledgerParty,
      keepId,
      loserIds,
      liveOnly: true,

      overrides: (
        await DECLARED_EDGE_MERGE_HOOKS.ledgerParty({
          tx,
          keepId,
          loserIds,
          actor,
          onAttributions: (value) => {
            attributionEdgesRepointed = value;
          },
          onPortions: (value) => {
            portionEdgesRepointed = value;
          },
          onInventory: (value) => {
            inventoryEdgesRepointed = value;
          },
        })
      ).overrides,
    });
    foodEntryEdgesRepointed = repointed["MealFoodEntry.ledgerPartyId"] ?? 0;
    accountEdgesRepointed = repointed["FinancialAccount.ledgerPartyId"] ?? 0;
    deviceEdgesRepointed = repointed["Device.ledgerPartyId"] ?? 0;
    transferEdgesRepointed =
      (repointed["LedgerTransfer.fromPartyId"] ?? 0) +
      (repointed["LedgerTransfer.toPartyId"] ?? 0);
    merged = (
      await finalizeMerge(tx, {
        entity: "ledgerParty",
        table: ledgerParty,
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
      })
    ).removed;
  });
  return {
    mergeSummary: {
      deletedIds: uniq(input.mergeIds),
      merged,
      attributionEdgesRepointed,
      accountEdgesRepointed,
      inventoryEdgesRepointed,
      transferEdgesRepointed,
      portionEdgesRepointed,
      foodEntryEdgesRepointed,
      deviceEdgesRepointed,
      carriedFields: [],
    },
  };
}

export const ledgerPartyMergeEdgeHandlers = (context: {
  tx: DrizzleTransaction;
  keepId: LedgerPartyId;
  loserIds: LedgerPartyId[];
  actor: ActorContext;
  onAttributions: (value: number) => void;
  onPortions: (value: number) => void;
  onInventory: (value: number) => void;
}) => {
  const {
    tx,
    keepId,
    loserIds,
    actor,
    onAttributions,
    onPortions,
    onInventory,
  } = context;
  const partyIds = [keepId, ...loserIds];
  return {
    foldWeightedAttributions: async () => {
      const shares = await tx
        .select({
          expenseId: expenseAttribution.expenseId,
          role: expenseAttribution.role,
          weight: expenseAttribution.weight,
        })
        .from(expenseAttribution)
        .where(
          and(
            inArray(expenseAttribution.ledgerPartyId, [keepId, ...loserIds]),
            notDeleted(expenseAttribution),
          ),
        );
      const sharesByExpenseRole = new Map<string, typeof shares>();
      for (const share of shares) {
        const key = `${share.expenseId}:${share.role}`;
        sharesByExpenseRole.set(key, [
          ...(sharesByExpenseRole.get(key) ?? []),
          share,
        ]);
      }
      for (const group of sharesByExpenseRole.values()) {
        const foldedWeight = group.reduce(
          (total, share) => total + share.weight,
          0,
        );
        if (!Number.isSafeInteger(foldedWeight))
          throw createAppError(
            "CONSTRAINT_VIOLATION",
            "Merged attribution weights exceed the safe integer range.",
          );
      }
      await tx
        .update(expenseAttribution)
        .set({ deletedAt: new Date() })
        .where(
          and(
            inArray(expenseAttribution.ledgerPartyId, [keepId, ...loserIds]),
            notDeleted(expenseAttribution),
          ),
        );
      for (const [_key, group] of sharesByExpenseRole) {
        const first = group[0]!;
        await insertPurchaseEventRows(tx, "ExpenseAttribution", {
          expenseId: first.expenseId,
          role: first.role,
          ledgerPartyId: keepId,
          weight: group.reduce((total, share) => total + share.weight, 0),
        });
      }
      onAttributions(shares.length);
    },
    foldPortions: async () => {
      await lockMealRecipePortionReferences(tx, partyIds);
      onPortions(await foldMealRecipePortions(tx, keepId, loserIds));
    },
    moveInventoryOwnership: async () => {
      const ownedInventory = await tx.query.inventoryEntry.findMany({
        where: {
          RAW: (table: PgTable) =>
            relationalSql(
              table,
              and(
                inArray(inventoryEntry.ownerLedgerPartyId, loserIds),
                notDeleted(inventoryEntry),
              ),
            ),
        },
        columns: { id: true },
        orderBy: (table: PgTable) =>
          [inventoryEntry.id]
            .flat()
            .map((value) => relationalSql(table, value)),
      });
      for (const row of ownedInventory) {
        await applyInventoryOwnershipInTransaction(
          tx,
          row.id,
          { ownershipMode: "explicit", ownerLedgerPartyId: keepId },
          undefined,
          actor,
        );
      }
      onInventory(ownedInventory.length);
    },
  };
};
export const beforeLedgerPartyDeletion = async (
  tx: DrizzleTransaction,
  ids: LedgerPartyId[],
): Promise<void> => {
  await refuseHouseholdParty(tx, ids);
  await assertNoAccountHistory(tx, ids);
};
