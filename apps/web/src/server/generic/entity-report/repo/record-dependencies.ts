import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";

import { getPurchaseFinanceByID } from "~/server/domains/purchase/repo/purchase";
import {
  resolveOrThrow,
  resolveLiveShortcode,
} from "~/server/generic/shortcode/repo/shortcode-resolver";

import { reportDependency } from "./dependency";

/** One live identity per entity in the request; loaders consume the parsed id. */
const recordIdentity = <E extends ShortcodeEntity>(entity: E) =>
  reportDependency(({ request: { db, id } }) => resolveOrThrow(db, entity, id));

export const runId = reportDependency(async ({ request: { db, id: code } }) => {
  const id = await resolveLiveShortcode(db, code, "run");
  if (!id) throw new Error("Import run was not found");
  return id;
});
export const reportMember = reportDependency(async ({ request }) => {
  const party = await request.viewer();
  if (!party)
    throw new Error("This login is not linked to a member ledger party yet.");
  return party;
});
export const projectId = recordIdentity("project");
export const productId = recordIdentity("product");
export const purchaseId = recordIdentity("purchase");
export const recipeId = recordIdentity("recipe");
export const locationId = recordIdentity("location");
export const cookbookId = recordIdentity("cookbook");

// Compute demand from the whole request, not whichever slot runs first.
export const purchaseFinance = reportDependency(async (execution) => {
  const { slots, db } = execution.request;
  return getPurchaseFinanceByID(db, await execution.read(purchaseId), {
    reconciliation: slots.includes("purchase.reconciliation"),
    allocation: slots.includes("purchase.project-allocation"),
    settlement: slots.includes("purchase.financial-settlement"),
  });
});
