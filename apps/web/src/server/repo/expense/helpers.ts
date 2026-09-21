import type {
  ExpenseId,
  ProductId,
  ProjectId,
  PurchaseId,
  VendorId,
} from "@cubby/schemas/identifiers";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import {
  type ImageRenderStatus,
  type ImageStorageStatus,
  isDisplayableImageFile,
} from "@cubby/schemas/image";
import type { ExpenseOut } from "@cubby/schemas/project";
import { purchaseOrderUrl } from "@cubby/schemas/vendor";

import { createAppError } from "~/server/errors/app-error";
import {
  resolveLiveJoinName,
  resolveLiveJoinShortcode,
} from "~/server/repo/database-helpers";
import { getR2PublicUrl } from "~/server/utils/r2-public-url";

import type { ExpenseProjectAllocationRow } from "../expense-project-allocation";

/**
 * Reject a quantity whose sign contradicts the money's direction.
 *
 * `Expense.productQuantity` is signed and money direction wins: a positive cost
 * is an acquisition of `+|qty|` and a negative cost an exit of `−|qty|`, so a
 * contradicting sign says nothing and only corrupts the aggregates that sum the
 * raw column.
 *
 * The negative-cost half is enforced unconditionally: a returns/refund row
 * must store a negative quantity matching its negative cost, keeping the
 * aggregates that sum the raw column trustworthy. The readers deliberately
 * keep their `abs()` (see `expenseSignedUnitsSql`): this enforcement makes the
 * column trustworthy, it does not make them depend on it.
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
  effectiveProjectId?: ProjectId | null;
  effectiveProjectShortcode?: string | null;
  effectiveProjectName?: string | null;
  effectiveTrade?: ExpenseOut["trade"];
  fallbackProjectShortcode?: string | null;
  fallbackTrade?: ExpenseOut["trade"];
  projectResolutionSource?: string;
  tradeResolutionSource?: string;
  projectAllocations?: ExpenseProjectAllocationRow[];
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

const purchaseVendorLogo = (
  purchaseRow: ExpenseRow["purchase"],
): ExpenseOut["vendorLogo"] => {
  const vendor = purchaseRow?.vendor;
  const logo = vendor?.logo;
  if (vendor?.deletedAt !== null || logo?.deletedAt !== null) return null;
  if (!logo || !isDisplayableImageFile(logo)) return null;
  return { url: getR2PublicUrl(logo.key) };
};

const expenseAttributions = (
  row: ExpenseRow,
  role: "beneficiary" | "funder",
): ExpenseOut["beneficiaries"] =>
  row.attributions
    .filter((value) => value.deletedAt === null && value.role === role)
    .map((value) => ({
      partyId:
        value.ledgerParty?.deletedAt === null
          ? parseShortcodeFor("ledgerParty", value.ledgerParty.shortcode)
          : null,
      weight: value.weight,
    }));

const expenseSourceClaims = (row: ExpenseRow): ExpenseOut["sourceClaims"] =>
  row.sourceClaims
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
    }));

const expenseProjectFieldResolution = (
  row: ExpenseRow,
  purchaseRow: ExpenseRow["purchase"],
  storedProjectShortcode: string | null,
  effectiveProjectShortcode: string | null,
): NonNullable<ExpenseOut["fieldResolutions"]>[string] => {
  let mode: "allocated" | "explicit" | "inherit" = "inherit";
  if (row.lineKind !== "principal") mode = "allocated";
  else if (storedProjectShortcode) mode = "explicit";

  const source =
    row.projectResolutionSource ??
    (row.lineKind !== "principal"
      ? "purchase allocation"
      : storedProjectShortcode
        ? "expense override"
        : effectiveProjectShortcode
          ? "inherited default"
          : "none");
  let sourceEntity: NonNullable<
    ExpenseOut["fieldResolutions"]
  >[string]["sourceEntity"] = effectiveProjectShortcode
    ? { entityType: "project" as const, entityId: effectiveProjectShortcode }
    : null;
  if (source === "purchase default" && purchaseRow) {
    sourceEntity = {
      entityType: "purchase" as const,
      entityId: purchaseRow.shortcode,
    };
  }
  return {
    mode,
    storedValue: storedProjectShortcode,
    value: effectiveProjectShortcode,
    fallbackValue: row.fallbackProjectShortcode ?? null,
    source,
    sourceEntity,
    matchesFallback:
      effectiveProjectShortcode === (row.fallbackProjectShortcode ?? null),
    canReset: storedProjectShortcode !== null,
  };
};

const expenseTradeFieldResolution = (
  row: ExpenseRow,
  purchaseRow: ExpenseRow["purchase"],
  effectiveProjectShortcode: string | null,
  effectiveTrade: ExpenseOut["trade"],
): NonNullable<ExpenseOut["fieldResolutions"]>[string] => {
  const source =
    row.tradeResolutionSource ??
    (row.trade !== null
      ? "expense override"
      : effectiveTrade
        ? "inherited default"
        : "none");
  let sourceEntity = null;
  if (source === "purchase default" && purchaseRow) {
    sourceEntity = {
      entityType: "purchase" as const,
      entityId: purchaseRow.shortcode,
    };
  } else if (source === "project default" && effectiveProjectShortcode) {
    sourceEntity = {
      entityType: "project" as const,
      entityId: effectiveProjectShortcode,
    };
  }
  return {
    mode: row.trade !== null ? "explicit" : effectiveTrade ? "inherit" : "none",
    storedValue: row.trade,
    value: effectiveTrade,
    fallbackValue: row.fallbackTrade ?? null,
    source,
    sourceEntity,
    matchesFallback: effectiveTrade === (row.fallbackTrade ?? null),
    canReset: row.trade !== null,
  };
};

const expenseProjectAllocations = (
  row: ExpenseRow,
): ExpenseOut["projectAllocations"] =>
  row.projectAllocations
    ?.filter(
      (
        allocation,
      ): allocation is typeof allocation & {
        basis: "positive" | "refund" | "default";
      } => allocation.basis !== "principal",
    )
    .map((allocation) => ({
      projectId: allocation.projectShortcode
        ? parseShortcodeFor("project", allocation.projectShortcode)
        : null,
      projectName: allocation.projectName,
      amount:
        allocation.attributedCents === null
          ? null
          : Number(allocation.attributedCents) / 100,
      basis: allocation.basis,
      incomplete: allocation.incomplete,
    }));

const expenseProjectId = (
  row: ExpenseRow,
  effectiveProjectShortcode: string | null,
) =>
  toProjectShortcode(
    row.effectiveProjectShortcode === undefined
      ? resolveLiveJoinShortcode(row.project)
      : effectiveProjectShortcode,
  );

const expenseProjectName = (row: ExpenseRow) =>
  row.effectiveProjectName === undefined
    ? resolveLiveJoinName(row.project)
    : row.effectiveProjectName;

export const dbExpenseToAPI = (row: ExpenseRow): ExpenseOut => {
  // A soft-deleted Purchase reads as no Purchase at all — the same rule
  // `resolveLiveJoinName` applies to project/product below, so a deleted parent
  // renders blank rather than as live data.
  const purchaseRow = row.purchase?.deletedAt === null ? row.purchase : null;

  const effectiveProjectShortcode =
    row.effectiveProjectShortcode === undefined
      ? resolveLiveJoinShortcode(row.project)
      : row.effectiveProjectShortcode;
  const effectiveTrade =
    row.effectiveTrade === undefined ? row.trade : row.effectiveTrade;
  const storedProjectShortcode = resolveLiveJoinShortcode(row.project);

  return {
    id: parseShortcodeFor("expense", row.shortcode),
    name: row.name,
    cost: row.cost,
    date: row.date,
    lineKind: row.lineKind,
    lineBasis: row.lineBasis,
    costType: row.costType,
    trade: effectiveTrade,
    url: row.url,
    notes: row.notes,
    future: row.future,
    projectId: expenseProjectId(row, effectiveProjectShortcode),
    projectName: expenseProjectName(row),
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
    vendorLogo: purchaseVendorLogo(purchaseRow),
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
    beneficiaries: expenseAttributions(row, "beneficiary"),
    funders: expenseAttributions(row, "funder"),
    sourceClaims: expenseSourceClaims(row),
    fieldResolutions:
      row.effectiveProjectShortcode === undefined
        ? undefined
        : {
            projectId: expenseProjectFieldResolution(
              row,
              purchaseRow,
              storedProjectShortcode,
              effectiveProjectShortcode,
            ),
            trade: expenseTradeFieldResolution(
              row,
              purchaseRow,
              effectiveProjectShortcode,
              effectiveTrade,
            ),
          },
    projectAllocations: expenseProjectAllocations(row),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
};
