import type {
  ExpenseId,
  ProductId,
  ProjectId,
  PurchaseId,
  VendorId,
} from "@cubby/schemas/identifiers";
import { parseEntityId, parseShortcodeFor } from "@cubby/schemas/identifiers";
import {
  type ImageRenderStatus,
  type ImageStorageStatus,
  isDisplayableImageFile,
} from "@cubby/schemas/image";
import type { ExpenseOut } from "@cubby/schemas/project";
import { HOUSEHOLD_PROJECT_SHORTCODE } from "@cubby/schemas/project";
import { purchaseOrderUrl } from "@cubby/schemas/vendor";
import { FOOD_CATEGORY } from "@cubby/shared";
import { and, inArray } from "drizzle-orm";
import { uniq } from "es-toolkit";

import type { DrizzleTransaction } from "~/server/db";
import { product } from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import {
  notDeleted,
  resolveLiveJoinName,
  resolveLiveJoinShortcode,
} from "~/server/repo/database-helpers";
import { resolveLiveShortcode } from "~/server/repo/shortcode-resolver";
import { getR2PublicUrl } from "~/server/utils/r2-public-url";

/**
 * Reject a quantity whose sign contradicts the money's direction.
 *
 * `Expense.productQuantity` is signed and money direction wins: a positive cost
 * is an acquisition of `+|qty|` and a negative cost an exit of `−|qty|`, so a
 * contradicting sign says nothing and only corrupts the aggregates that sum the
 * raw column.
 *
 * The negative-cost half was NOT enforced until 2026-08-16, because 302 live
 * rows stored a positive quantity there — returns and refunds imported as
 * written. Those were normalized on 2026-08-06, and the 69 that imports had
 * reintroduced since were normalized on 2026-08-16, so the stored sign is now
 * consistent and this closes the door behind it. The readers deliberately keep
 * their `abs()` (see `expenseSignedUnitsSql`): this makes the column
 * trustworthy, it does not make them depend on it.
 *
 * A negative-cost line where no unit actually left — an Amazon "Account
 * adjustment" is a price concession with the item KEPT — takes `0`, not a
 * negative and no longer `null`: the quantity there is known to be zero, and
 * spelling it `null` reported a certainty as missing data (the `−N?` cue beside
 * Expected).
 *
 * Zero is rejected in every other direction, because "money moved but no unit
 * did" is a claim about the money, and only a **known negative** cost supports
 * it. A positive line with no units is a fee or an allocation, neither of which
 * may carry a product; a $0 line with no units is not an event at all; and an
 * unclassified line (`cost IS NULL`) does not yet know which way the money
 * went, so it cannot assert a concession either. That last case is why the zero
 * check sits ABOVE the null-cost early return — the return exists to stop this
 * function second-guessing a direction it cannot see, but zero is wrong
 * *because* the direction is unknown, which is a conclusion, not a guess.
 */
export const assertQuantitySignMatchesCost = (
  cost: number | null,
  productQuantity: number | null,
) => {
  // Deliberately before the early return below: a null cost makes zero wrong,
  // not unknowable. See the doc comment.
  if (productQuantity === 0 && !(cost !== null && cost < 0)) {
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "A quantity of zero means money moved but no unit did, which only a refund can claim. Give this line a negative cost, or leave the quantity null if the count is genuinely unknown.",
    );
  }
  if (cost === null || productQuantity === null) {
    return;
  }
  if (cost > 0 && productQuantity < 0) {
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "A positive-cost line is an acquisition; its quantity cannot be negative. Record an exit as a negative cost, or as a $0 line with a negative quantity.",
    );
  }
  if (cost < 0 && productQuantity > 0) {
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "A negative-cost line is an exit; its quantity cannot be positive. Record the units that left as a negative quantity, or use 0 if no unit left (a price concession where the item was kept).",
    );
  }
};

/**
 * Shape of an `expense` row loaded with its (nullable) parent `project`, its
 * linked `product`, and the vendor `purchase` event it belongs to — with that
 * charge's `vendor` in turn.
 */

/** Brand a resolved join shortcode, preserving null for an absent/deleted parent. */
const toProductShortcode = (code: string | null) =>
  code === null ? null : parseShortcodeFor("product", code);

const toProjectShortcode = (code: string | null) =>
  code === null ? null : parseShortcodeFor("project", code);

export type ExpenseRow = {
  id: ExpenseId;
  shortcode: string;
  name: string;
  cost: number | null;
  date: string;
  lineKind: ExpenseOut["lineKind"];
  lineBasis: ExpenseOut["lineBasis"];
  costType: ExpenseOut["costType"];
  trade: ExpenseOut["trade"];
  url: string | null;
  notes: string | null;
  future: boolean;
  projectId: ProjectId | null;
  productId: ProductId | null;
  productQuantity: number | null;
  purchaseId: PurchaseId | null;
  createdAt: Date;
  updatedAt: Date;
  project: { name: string; shortcode: string; deletedAt: Date | null } | null;
  product: { name: string; shortcode: string; deletedAt: Date | null } | null;
  purchase: {
    id: PurchaseId;
    shortcode: string;
    orderId: string | null;
    displayLabel: string | null;
    date: string;
    vendorId: VendorId;
    deletedAt: Date | null;
    vendor: {
      name: string;
      shortcode: string;
      orderUrlTemplate: string | null;
      deletedAt: Date | null;
      logo: {
        key: string;
        contentType: string;
        renderStatus: ImageRenderStatus | null;
        storageStatus: ImageStorageStatus | null;
        deletedAt: Date | null;
      } | null;
    } | null;
  } | null;
  attributions: Array<{
    role: "beneficiary" | "funder";
    ledgerPartyId: string | null;
    weight: number;
    deletedAt: Date | null;
    ledgerParty: { shortcode: string; deletedAt: Date | null } | null;
  }>;
  sourceClaims: Array<{
    source: string;
    sourceKey: string;
    sourceKeyVersion: number;
    normalizedEvidence: ExpenseOut["sourceClaims"][number]["normalizedEvidence"];
    targetAmountAtClaim: number;
    reconciliationDecision: "amounts_match" | "accept_target_amount";
    reconciliationNote: string | null;
    createdAt: Date;
    updatedAt: Date;
    deletedAt: Date | null;
  }>;
};

export const dbExpenseToAPI = (row: ExpenseRow): ExpenseOut => {
  // A soft-deleted Purchase reads as no Purchase at all — the same rule
  // `resolveLiveJoinName` applies to project/product below, so a deleted parent
  // renders blank rather than as live data.
  const purchaseRow = row.purchase?.deletedAt === null ? row.purchase : null;

  return {
    id: parseShortcodeFor("expense", row.shortcode),
    name: row.name,
    cost: row.cost,
    date: row.date,
    lineKind: row.lineKind,
    lineBasis: row.lineBasis,
    costType: row.costType,
    trade: row.trade,
    url: row.url,
    notes: row.notes,
    future: row.future,
    projectId: toProjectShortcode(resolveLiveJoinShortcode(row.project)),
    projectName: resolveLiveJoinName(row.project),
    productId: toProductShortcode(resolveLiveJoinShortcode(row.product)),
    productName: resolveLiveJoinName(row.product),
    productQuantity: row.productQuantity,
    // `vendor` and `orderId` are no longer columns on `Expense` — the Purchase
    // owns them, and they resolve through this join. Keeping the SAME output
    // keys is deliberate: it's what let the ledger's Vendor / Order # columns,
    // the MCP surface, and the purchase-import skill survive the split
    // untouched.
    //
    // `vendorId` is the Purchase's vendor FK, denormalized — always present on a
    // live Purchase regardless of whether the VENDOR itself was soft-deleted
    // (same "shortcode is a permanent tombstone" reasoning as
    // `purchaseOut.vendorId`); `vendor` (the display name) is separately
    // gated on the vendor's own liveness via `resolveLiveJoinName`.
    purchaseId: purchaseRow
      ? parseShortcodeFor("purchase", purchaseRow.shortcode)
      : null,
    purchaseDate: purchaseRow?.date ?? null,
    purchaseDisplayLabel: purchaseRow?.displayLabel ?? null,
    vendorId:
      purchaseRow?.vendor != null
        ? parseShortcodeFor("vendor", purchaseRow.vendor.shortcode)
        : null,
    vendor: purchaseRow ? resolveLiveJoinName(purchaseRow.vendor) : null,
    vendorLogo:
      purchaseRow?.vendor?.deletedAt === null &&
      purchaseRow.vendor.logo?.deletedAt === null &&
      isDisplayableImageFile(purchaseRow.vendor.logo)
        ? { url: getR2PublicUrl(purchaseRow.vendor.logo.key) }
        : null,
    orderId: purchaseRow?.orderId ?? null,
    // Derived, never stored: the vendor's own order page for this order. Gated
    // on the vendor's liveness like `vendor` above — a soft-deleted vendor's
    // template shouldn't keep producing links.
    orderUrl:
      purchaseRow?.vendor?.deletedAt === null
        ? purchaseOrderUrl({
            orderUrlTemplate: purchaseRow.vendor.orderUrlTemplate,
            orderId: purchaseRow.orderId,
          })
        : null,
    beneficiaries: row.attributions
      .filter(
        (value) => value.deletedAt === null && value.role === "beneficiary",
      )
      .map((value) => ({
        partyId:
          value.ledgerParty?.deletedAt === null
            ? parseShortcodeFor("ledgerParty", value.ledgerParty.shortcode)
            : null,
        weight: value.weight,
      })),
    funders: row.attributions
      .filter((value) => value.deletedAt === null && value.role === "funder")
      .map((value) => ({
        partyId:
          value.ledgerParty?.deletedAt === null
            ? parseShortcodeFor("ledgerParty", value.ledgerParty.shortcode)
            : null,
        weight: value.weight,
      })),
    sourceClaims: row.sourceClaims
      .filter((value) => value.deletedAt === null)
      .map((value) => ({
        source: value.source,
        normalizedEvidence: value.normalizedEvidence,
        reconciliation:
          value.reconciliationDecision === "amounts_match"
            ? { decision: "amounts_match" as const }
            : {
                decision: "accept_target_amount" as const,
                note: value.reconciliationNote ?? "Reconciliation note missing",
              },
        sourceKey: value.sourceKey,
        sourceKeyVersion: value.sourceKeyVersion,
        targetAmountAtClaim: value.targetAmountAtClaim,
        createdAt: value.createdAt,
        updatedAt: value.updatedAt,
      })),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
};

/**
 * The creation-time triage default: a food line with no project belongs to
 * Household.
 *
 * Imports and split replacement rows use it while creating expenses.
 * `updateExpense` and `moveExpenses` deliberately do NOT — an update is an
 * explicit statement about one row the operator is looking at, and
 * `moveExpenses` is the bulk move-to-inbox undo. Re-defaulting in either would
 * make "clear the project on this food line" impossible, bouncing every clear
 * straight back to Household with no error and no audit diff to explain it.
 * Automation triages, humans override, an override is never re-triaged.
 *
 * Returns `null` when no Household project exists, so a database that has not
 * been backfilled (every existing test, any fresh dev DB) behaves exactly as it
 * did before. Absence degrades, it never throws.
 *
 * Scope is `category === 'food'` on purpose. The other backfilled cohort —
 * household/supplies repurchased three or more times — is a retrospective
 * aggregate over a product's history; evaluating it per-insert would cost a
 * grouped query on every create and would triage the third bottle of shampoo
 * while leaving the first two behind.
 */
export const resolveDefaultProjectIds = async (
  tx: DrizzleTransaction,
  inputs: ReadonlyArray<{
    projectId: ProjectId | null;
    productId: ProductId | null;
  }>,
): Promise<Array<ProjectId | null>> => {
  const candidates = uniq(
    inputs.flatMap((input) =>
      input.projectId === null && input.productId !== null
        ? [input.productId]
        : [],
    ),
  );
  if (candidates.length === 0) return inputs.map((input) => input.projectId);

  const foodProducts = new Set(
    (
      await tx.query.product.findMany({
        where: and(inArray(product.id, candidates), notDeleted(product)),
        columns: { id: true, category: true },
      })
    )
      .filter((row) => row.category === FOOD_CATEGORY)
      .map((row) => row.id),
  );
  if (foodProducts.size === 0) return inputs.map((input) => input.projectId);

  const householdId = await resolveLiveShortcode(
    tx,
    HOUSEHOLD_PROJECT_SHORTCODE,
    "project",
  );
  const parsedHouseholdId = householdId
    ? parseEntityId("project", householdId)
    : null;
  return inputs.map((input) =>
    input.projectId === null &&
    input.productId !== null &&
    foodProducts.has(input.productId)
      ? parsedHouseholdId
      : input.projectId,
  );
};

export const resolveDefaultProjectId = async (
  tx: DrizzleTransaction,
  input: { projectId: ProjectId | null; productId: ProductId | null },
): Promise<ProjectId | null> =>
  (await resolveDefaultProjectIds(tx, [input]))[0] ?? null;
