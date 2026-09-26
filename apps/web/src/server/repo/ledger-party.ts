import type { ActorContext } from "@cubby/schemas/context";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import type { OperationDisposition } from "@cubby/schemas/entity-integrity";
import type {
  LedgerPartyId,
  LedgerPartyShortcode,
} from "@cubby/schemas/identifiers";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import type {
  LedgerPartyCreateInput,
  LedgerPartyFilters,
  LedgerPartyOptionsOut,
  LedgerPartyOut,
  LedgerPartyUpdateData,
} from "@cubby/schemas/ledger-party";
import { ledgerPartyOut } from "@cubby/schemas/ledger-party";
import {
  type MealFoodAmount,
  mealFoodAmountFromStored,
} from "@cubby/schemas/meal";
import type { PaginationParams, SortParams } from "@cubby/schemas/pagination";
import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import { uniq } from "es-toolkit";

import type { Database, DrizzleTransaction } from "~/server/db";
import type { IncomingEdgePolicy } from "~/server/db/entity-incoming-edges";
import {
  device,
  expenseAttribution,
  financialAccount,
  image,
  imageSighting,
  inventoryEntry,
  ledgerParty,
  ledgerTransfer,
  meal,
  mealFoodEntry,
  mealRecipe,
  mealRecipePortion,
  photoGroupProposal,
} from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import { computeChanges, logAuditEntry } from "~/server/repo/audit-log";
import { loadDataQualities } from "~/server/repo/data-quality";
import {
  buildPartialUpdateValues,
  getDb,
  notDeleted,
  unwrapDb,
  withTransaction,
} from "~/server/repo/database-helpers";
import { createEntityReader } from "~/server/repo/entity-crud-factory";
import { applyInventoryOwnershipInTransaction } from "~/server/repo/inventory/ownership-mutations";
import { listScaffold } from "~/server/repo/list-scaffold";
import { finalizeMerge, resolveMergeTargets } from "~/server/repo/merge/core";
import { relatedWhereConditions } from "~/server/repo/related-view";
import { policyDelete } from "~/server/repo/removal";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

export const LEDGER_PARTY_DELETE_EDGE_POLICY = {
  "VendorAccount.ledgerPartyId": {
    code: "block-vendor-accounts",
    effect: "block",
    description: "Member-owned vendor accounts retain their owner.",
  },
  "Run.ledgerPartyId": {
    code: "block-runs",
    effect: "block",
    description: "Import provenance retains the member scope.",
  },
  "ImportSourceClaim.ledgerPartyId": {
    code: "block-import-claims",
    effect: "block",
    description: "Import source claims retain the member scope.",
  },
  "RunFinding.ledgerPartyId": {
    code: "block-import-findings",
    effect: "block",
    description: "Import findings retain the member scope.",
  },
  "ImportHunt.ledgerPartyId": {
    code: "block-import-hunts",
    effect: "block",
    description: "Import hunts retain the member scope.",
  },
  "MerchantVendorRule.ledgerPartyId": {
    code: "block-merchant-rules",
    effect: "block",
    description: "Merchant routing rules retain the member scope.",
  },
  "MailboxCursor.ledgerPartyId": {
    code: "block-mailbox-cursor",
    effect: "block",
    description: "Mailbox cursors retain their member scope.",
  },
  "OrderMail.ledgerPartyId": {
    code: "block-order-mail",
    effect: "block",
    description: "Order mail retains its member scope.",
  },
  "ExpenseAttribution.ledgerPartyId": {
    code: "block-attributions",
    effect: "block",
    description: "Live expense shares retain their party.",
  },
  "FinancialAccount.ledgerPartyId": {
    code: "block-accounts",
    effect: "block",
    description: "Live accounts retain their ledger party.",
  },
  "InventoryEntry.ownerLedgerPartyId": {
    code: "block-inventory-owners",
    effect: "block",
    description: "Explicit inventory ownership retains its individual owner.",
  },
  "LedgerTransfer.fromPartyId": {
    code: "block-outgoing-transfers",
    effect: "block",
    description: "Live transfers retain their source party.",
  },
  "LedgerTransfer.toPartyId": {
    code: "block-incoming-transfers",
    effect: "block",
    description: "Live transfers retain their target party.",
  },
  "MealRecipePortion.ledgerPartyId": {
    code: "block-meal-portions",
    effect: "block",
    description: "Live meal portions retain their eater.",
  },
  "MealFoodEntry.ledgerPartyId": {
    code: "block-meal-food-entries",
    effect: "block",
    description: "Live meal food entries retain their eater.",
  },
  "Device.ledgerPartyId": {
    code: "clear-owner",
    effect: "detach",
    description:
      "Deleting a member clears its devices' owner rather than blocking the delete — a device survives as an unowned install.",
  },
  "ImageSighting.ledgerPartyId": {
    code: "block-image-sightings",
    effect: "block",
    description:
      "A sighting's library owner retains its member scope; the reported evidence would be meaningless attached to no one.",
  },
  "Image.capturedByPartyId": {
    code: "clear-captured-by",
    effect: "detach",
    description:
      "Deleting a member clears the derived capturer on its images rather than blocking the delete — the image survives with no capturer until the next derivation.",
  },
  "PhotoGroupProposal.inventoryOwnerPartyId": {
    code: "clear-proposal-owner",
    effect: "detach",
    description:
      "Deleting a member clears a photo group proposal's inventory owner; the group can still be approved without one.",
  },
} as const satisfies IncomingEdgePolicy<"ledgerParty", OperationDisposition>;

export const LEDGER_PARTY_MERGE_EDGE_POLICY = {
  "VendorAccount.ledgerPartyId": {
    code: "block-vendor-accounts",
    effect: "block",
    description:
      "Vendor-account ownership must be reconciled before merging members.",
  },
  "Run.ledgerPartyId": {
    code: "block-runs",
    effect: "block",
    description: "Import provenance prevents member merges.",
  },
  "ImportSourceClaim.ledgerPartyId": {
    code: "block-import-claims",
    effect: "block",
    description: "Import source identity prevents member merges.",
  },
  "RunFinding.ledgerPartyId": {
    code: "block-import-findings",
    effect: "block",
    description: "Import findings prevent member merges.",
  },
  "ImportHunt.ledgerPartyId": {
    code: "block-import-hunts",
    effect: "block",
    description: "Import hunts prevent member merges.",
  },
  "MerchantVendorRule.ledgerPartyId": {
    code: "block-merchant-rules",
    effect: "block",
    description: "Merchant routes prevent member merges.",
  },
  "MailboxCursor.ledgerPartyId": {
    code: "block-mailbox-cursor",
    effect: "block",
    description: "Mailbox identity prevents member merges.",
  },
  "OrderMail.ledgerPartyId": {
    code: "block-order-mail",
    effect: "block",
    description: "Order mail provenance prevents member merges.",
  },
  "ExpenseAttribution.ledgerPartyId": {
    code: "merge-attributions",
    effect: "move-dedupe",
    description: "Colliding weighted shares are summed.",
  },
  "FinancialAccount.ledgerPartyId": {
    code: "repoint-accounts",
    effect: "repoint",
    description: "Accounts move to the surviving party.",
  },
  "InventoryEntry.ownerLedgerPartyId": {
    code: "merge-inventory-owners",
    effect: "move-dedupe",
    description:
      "Explicitly owned inventory moves to the surviving person and folds only when the complete raw slot and unit agree.",
  },
  "LedgerTransfer.fromPartyId": {
    code: "repoint-outgoing-transfers",
    effect: "repoint",
    description: "Transfer source endpoints move to the survivor.",
  },
  "LedgerTransfer.toPartyId": {
    code: "repoint-incoming-transfers",
    effect: "repoint",
    description: "Transfer target endpoints move to the survivor.",
  },
  "MealRecipePortion.ledgerPartyId": {
    code: "merge-meal-portions",
    effect: "move-dedupe",
    description:
      "Colliding portions for one preparation and target meal are summed when their entered units match; confirmation survives only when every folded portion was confirmed.",
  },
  "MealFoodEntry.ledgerPartyId": {
    code: "repoint-meal-food-entries",
    effect: "repoint",
    description:
      "Meal food entries move to the surviving party without changing their recorded amounts.",
  },
  "Device.ledgerPartyId": {
    code: "repoint-devices",
    effect: "repoint",
    description: "A merged member's devices move to the surviving party.",
  },
  "ImageSighting.ledgerPartyId": {
    code: "repoint-image-sightings",
    effect: "repoint",
    description:
      "A merged member's reported image sightings move to the surviving party.",
  },
  "Image.capturedByPartyId": {
    code: "repoint-captured-by",
    effect: "repoint",
    description:
      "Images derived to a merged member move to the surviving party.",
  },
  "PhotoGroupProposal.inventoryOwnerPartyId": {
    code: "repoint-proposal-owner",
    effect: "repoint",
    description:
      "A photo group proposed for a merged member is received by the surviving party.",
  },
} as const satisfies IncomingEdgePolicy<"ledgerParty", OperationDisposition>;

type LedgerPartyRow = typeof ledgerParty.$inferSelect;

const hydrate = async (
  db: Database | DrizzleTransaction,
  rows: LedgerPartyRow[],
): Promise<LedgerPartyOut[]> => {
  const dataQualities = await loadDataQualities(
    db,
    "ledgerParty",
    rows.map((row) => row.id),
  );
  return rows.map((row) =>
    ledgerPartyOut.parse({
      ...row,
      id: parseShortcodeFor("ledgerParty", row.shortcode),
      dataQuality: dataQualities.get(row.id),
    }),
  );
};

const scaffold = listScaffold("ledgerParty", ledgerParty);

const getById = async (
  db: Database | DrizzleTransaction,
  id: LedgerPartyId,
): Promise<LedgerPartyRow | undefined> => {
  const [row] = await unwrapDb(db)
    .select()
    .from(ledgerParty)
    .where(and(eq(ledgerParty.id, id), notDeleted(ledgerParty)))
    .limit(1);
  return row;
};

const reader = createEntityReader<
  LedgerPartyRow,
  LedgerPartyOut,
  "ledgerParty"
>({
  entity: "ledgerParty",
  fetchById: getById,
  fromDB: async (db, row) => (await hydrate(db, [row]))[0]!,
});

export const getLedgerPartyByShortcode = reader.getByShortcode;

/** The complete WHERE for this entity's list; `search` and `kind` are declared. */
export const buildLedgerPartyWhere = (filters: LedgerPartyFilters) =>
  scaffold.where(filters, [
    ...relatedWhereConditions("ledgerParty", filters, ledgerParty.id),
  ]);

export const listLedgerParties = (
  db: Database,
  filters: LedgerPartyFilters,
  sorts: SortParams[],
  pagination: PaginationParams,
) =>
  scaffold.list(
    db,
    {
      filters,
      sorts: sorts.length ? sorts : [{ orderBy: "name", direction: "asc" }],
      pagination,
    },
    {
      where: buildLedgerPartyWhere(filters),
      hydrate: (rows) => hydrate(db, rows),
    },
  );

/**
 * The ledger-party picklist — feeds the accounts table's Owner editor.
 *
 * Deliberately eager and unpaginated, unlike the search-as-you-type reference
 * pickers: the household has a handful of parties, so the
 * whole roster is cheaper to ship than a query per keystroke. `kind` rides
 * along because the editor labels a party by it (Member / Guest / Household)
 * rather than by name alone.
 */
export const ledgerPartyOptions = async (
  db: Database,
): Promise<LedgerPartyOptionsOut> => {
  const rows = await getDb(db)
    .select({
      shortcode: ledgerParty.shortcode,
      name: ledgerParty.name,
      kind: ledgerParty.kind,
    })
    .from(ledgerParty)
    .where(notDeleted(ledgerParty))
    .orderBy(asc(ledgerParty.name));

  return rows.map((row) => ({
    id: parseShortcodeFor("ledgerParty", row.shortcode),
    name: row.name,
    kind: row.kind,
  }));
};

export async function createLedgerParty(
  db: Database,
  data: LedgerPartyCreateInput,
  actor: ActorContext,
) {
  const id = await withTransaction(db, async (tx) => {
    if (data.kind === "household") {
      const [existing] = await tx
        .select({ id: ledgerParty.id })
        .from(ledgerParty)
        .where(and(eq(ledgerParty.kind, "household"), notDeleted(ledgerParty)))
        .limit(1);
      if (existing)
        throw createAppError(
          "CONSTRAINT_VIOLATION",
          "Only one household ledger party may exist.",
        );
    }
    const created = await insertWithShortcode(tx, "ledgerParty", data);
    await logAuditEntry(tx, actor, {
      entityType: "ledgerParty",
      entityId: created.id,
      action: "create",
    });
    return created.id;
  });
  return { output: await reader.getByID(db, id), entityId: id };
}

export async function updateLedgerParty(
  db: Database,
  shortcode: LedgerPartyShortcode,
  data: LedgerPartyUpdateData,
  actor: ActorContext,
) {
  const id = await resolveOrThrow(db, "ledgerParty", shortcode);
  await withTransaction(db, async (tx) => {
    const [before] = await tx
      .select()
      .from(ledgerParty)
      .where(and(eq(ledgerParty.id, id), notDeleted(ledgerParty)))
      .for("update")
      .limit(1);
    if (!before)
      throw createAppError(
        "LEDGER_PARTY_NOT_FOUND",
        `Ledger party not found: ${shortcode}`,
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
    if (before.kind !== "guest" && data.kind === "guest") {
      const [mappedAccount] = await tx
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
    const values = buildPartialUpdateValues(data);
    await tx
      .update(ledgerParty)
      .set(values)
      .where(and(eq(ledgerParty.id, id), notDeleted(ledgerParty)));
    const changes = computeChanges(before, { ...before, ...values }, [
      ...entityFieldModels.ledgerParty.audit,
    ]);
    if (changes)
      await logAuditEntry(tx, actor, {
        entityType: "ledgerParty",
        entityId: id,
        action: "update",
        changes,
      });
  });
  return { output: await reader.getByID(db, id), entityId: id };
}

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
  LEDGER_PARTY_DELETE_EDGE_POLICY,
  { beforeDelete: refuseHouseholdParty },
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
      amount: mealRecipePortion.amount,
      grams: mealRecipePortion.grams,
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
    const amounts = group.map((portion) => mealFoodAmountFromStored(portion));
    if (amounts.some((amount) => amount === null))
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        "A meal portion is missing its amount; reconcile the portion before merging ledger parties.",
      );
    const presentAmounts = amounts.filter(
      (amount): amount is MealFoodAmount => amount !== null,
    );
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
      amount: foldedAmounts.get(key)!,
      grams: null,
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
      await tx.insert(expenseAttribution).values({
        expenseId: first.expenseId,
        role: first.role,
        ledgerPartyId: keepId,
        weight: group.reduce((total, share) => total + share.weight, 0),
      });
    }
    attributionEdgesRepointed = shares.length;
    const partyIds = [keepId, ...loserIds];
    await lockMealRecipePortionReferences(tx, partyIds);
    portionEdgesRepointed = await foldMealRecipePortions(tx, keepId, loserIds);
    foodEntryEdgesRepointed = (
      await tx
        .update(mealFoodEntry)
        .set({ ledgerPartyId: keepId })
        .where(
          and(
            inArray(mealFoodEntry.ledgerPartyId, loserIds),
            notDeleted(mealFoodEntry),
          ),
        )
        .returning({ id: mealFoodEntry.id })
    ).length;
    const [accountCount] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(financialAccount)
      .where(
        and(
          inArray(financialAccount.ledgerPartyId, loserIds),
          notDeleted(financialAccount),
        ),
      );
    accountEdgesRepointed = accountCount?.n ?? 0;
    const ownedInventory = await tx.query.inventoryEntry.findMany({
      where: and(
        inArray(inventoryEntry.ownerLedgerPartyId, loserIds),
        notDeleted(inventoryEntry),
      ),
      columns: { id: true },
      orderBy: inventoryEntry.id,
    });
    for (const row of ownedInventory) {
      await applyInventoryOwnershipInTransaction(
        tx,
        row.id,
        { ownershipMode: "person", ownerLedgerPartyId: keepId },
        undefined,
        actor,
      );
    }
    inventoryEdgesRepointed = ownedInventory.length;
    const [transferCount] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(ledgerTransfer)
      .where(
        and(
          or(
            inArray(ledgerTransfer.fromPartyId, loserIds),
            inArray(ledgerTransfer.toPartyId, loserIds),
          ),
          notDeleted(ledgerTransfer),
        ),
      );
    transferEdgesRepointed = transferCount?.n ?? 0;
    await tx
      .update(financialAccount)
      .set({ ledgerPartyId: keepId })
      .where(
        and(
          inArray(financialAccount.ledgerPartyId, loserIds),
          notDeleted(financialAccount),
        ),
      );
    deviceEdgesRepointed = (
      await tx
        .update(device)
        .set({ ledgerPartyId: keepId })
        .where(and(inArray(device.ledgerPartyId, loserIds), notDeleted(device)))
        .returning({ id: device.id })
    ).length;
    await tx
      .update(imageSighting)
      .set({ ledgerPartyId: keepId })
      .where(
        and(
          inArray(imageSighting.ledgerPartyId, loserIds),
          notDeleted(imageSighting),
        ),
      );
    await tx
      .update(image)
      .set({ capturedByPartyId: keepId })
      .where(
        and(inArray(image.capturedByPartyId, loserIds), notDeleted(image)),
      );
    await tx
      .update(photoGroupProposal)
      .set({ inventoryOwnerPartyId: keepId })
      .where(inArray(photoGroupProposal.inventoryOwnerPartyId, loserIds));
    await tx
      .update(ledgerTransfer)
      .set({ fromPartyId: keepId })
      .where(
        and(
          inArray(ledgerTransfer.fromPartyId, loserIds),
          notDeleted(ledgerTransfer),
        ),
      );
    await tx
      .update(ledgerTransfer)
      .set({ toPartyId: keepId })
      .where(
        and(
          inArray(ledgerTransfer.toPartyId, loserIds),
          notDeleted(ledgerTransfer),
        ),
      );
    merged = (
      await finalizeMerge(tx, {
        entity: "ledgerParty",
        table: ledgerParty,
        keepId,
        loserIds,
        removal: "soft",
        actor,
        survivorChanges: { mergedFrom: { from: null, to: loserIds } },
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
