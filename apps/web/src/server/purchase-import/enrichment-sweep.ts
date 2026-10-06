import type {
  PurchaseId,
  RunId,
  VendorAccountId,
} from "@cubby/schemas/identifiers";
import { and, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import {
  auditLog,
  expense,
  product,
  purchase,
  run as runTable,
  runTarget,
} from "~/server/db/schema";
import { getDb, notDeleted, unwrapDb } from "~/server/repo/database-helpers";

import { browsingAccountFor, browsingAccounts } from "./browsing-account";
import { productEnrichmentTarget } from "./product-enrichment-target";
import {
  ACTIVE_RUN_STATUSES,
  type PurchaseImportNamespace,
  startTargetedRun,
  type TargetedRunTarget,
} from "./run-service";
import { dispatchStartedRun, enrichmentStartPage } from "./targeted-run";

/** How far back an import-created Product stays on the sweep's worklist. */
const SWEEP_WINDOW_MS = 60 * 24 * 60 * 60_000;
/** Runs a Product may end in without a commit or skip before it is left alone. */
const MAX_ENRICHMENT_ATTEMPTS = 3;
/** Products one run works; the rest wait for the next pass. */
const TARGETS_PER_RUN = 10;

/** Whether an account's Mac browser bridge has a live connection. */
type BrowserReachability = {
  connected(vendorAccountId: VendorAccountId): Promise<boolean>;
};

export const bridgeReachability = (
  namespace: PurchaseImportNamespace,
): BrowserReachability => ({
  connected: (id) => namespace.getByName(id).connected(),
});

type EnrichmentSweepResult = {
  started: { runId: RunId; vendorAccountId: VendorAccountId }[];
  waiting: {
    vendorAccountId: VendorAccountId;
    reason: "occupied" | "offline";
  }[];
};

/**
 * Start a `product_enrichment` run for each browsing account with Products a
 * purchase import created that no enrichment run has finished. This is the
 * one path that starts enrichment for imported Products: right after an
 * import commits, on every discovery pass (daily and on app open), and when
 * an account turns browser sync on. So a Product left behind by an occupied
 * account, an offline Mac, a mail-only account, or a crash after the import
 * committed is picked up by a later pass instead of waiting for a click.
 *
 * A run starts only when the account is free and, for a background pass
 * (`bridge`), its Mac is connected: a run started offline would hold the
 * account for a day and then fail. A Product is finished once a run commits or skips it; a Product
 * whose runs ended without either `MAX_ENRICHMENT_ATTEMPTS` times is left for
 * the member.
 */
export async function sweepPendingEnrichment(
  db: Database,
  options: {
    /** Without it every account is treated as reachable. */
    bridge?: BrowserReachability;
    /** Limit the pass to these accounts (an import's or a newly synced one). */
    vendorAccountIds?: readonly VendorAccountId[];
    now?: Date;
  } = {},
): Promise<EnrichmentSweepResult> {
  const result: EnrichmentSweepResult = { started: [], waiting: [] };
  const candidates = await pendingCandidates(
    db,
    new Date((options.now ?? new Date()).getTime() - SWEEP_WINDOW_MS),
  );
  const accounts = await browsingAccounts(
    db,
    candidates.map((row) => row.vendorId),
  );
  const byAccount = new Map<
    VendorAccountId,
    { account: (typeof accounts)[number]; rows: typeof candidates }
  >();
  const chosen = new Set<string>();
  // Candidates arrive oldest Product first, each Product's product page
  // first: a Product goes to the first of its Purchases whose Vendor browses.
  for (const row of candidates) {
    if (chosen.has(row.productId)) continue;
    const account = browsingAccountFor(accounts, row);
    if (!account) continue;
    if (
      options.vendorAccountIds &&
      !options.vendorAccountIds.includes(account.id)
    )
      continue;
    chosen.add(row.productId);
    const group = byAccount.get(account.id) ?? { account, rows: [] };
    group.rows.push(row);
    byAccount.set(account.id, group);
  }
  for (const { account, rows } of byAccount.values()) {
    if (options.bridge && !(await options.bridge.connected(account.id))) {
      result.waiting.push({ vendorAccountId: account.id, reason: "offline" });
      continue;
    }
    const targets = [];
    for (const row of rows) {
      if (targets.length === TARGETS_PER_RUN) break;
      const startUrl = await enrichmentStartPage(db, {
        productId: row.productId,
        vendorId: account.vendorId,
        pages: [row.url],
      });
      const live = await productEnrichmentTarget(getDb(db), row.productId);
      // No page on the Vendor's browser domains: the bridge could not open
      // one, so the Product waits for a domain or website on the Vendor.
      if (!startUrl || !live) continue;
      targets.push({
        kind: "product" as const,
        productId: row.productId,
        vendorAccountId: account.id,
        sourceExternalKey: startUrl,
        targetFingerprint: live.fingerprint,
      });
    }
    if (targets.length === 0) continue;
    const started = await startTargetedRun(
      db,
      {
        ledgerPartyId: account.ledgerPartyId,
        purpose: "product_enrichment",
        vendorId: account.vendorId,
        vendorAccountId: account.id,
        trigger: "discovery",
        targets,
      },
      { admit: admitOpenProducts },
    );
    if (!started.created) {
      // No blocking run: a racing pass already took every Product.
      if (started.blockingRun)
        result.waiting.push({
          vendorAccountId: account.id,
          reason: "occupied",
        });
      continue;
    }
    if (started.run.dispatchEventId)
      await dispatchStartedRun(db, {
        id: started.run.id,
        eventId: started.run.dispatchEventId,
        purpose: started.run.purpose,
      });
    result.started.push({ runId: started.run.id, vendorAccountId: account.id });
  }
  return result;
}

/**
 * Sweep only the browsing accounts of Purchases an import just committed, so
 * their new Products start enriching without waiting for the next pass. The
 * import is the member's own action, so this start does not wait for a Mac:
 * a run that pauses offline resumes when the bridge reconnects and replays
 * its command, and one that expires is retried by a later pass.
 */
export async function sweepImportedPurchases(
  db: Database,
  purchaseIds: readonly PurchaseId[],
) {
  if (purchaseIds.length === 0) return null;
  const owners = await getDb(db)
    .select({
      vendorId: purchase.vendorId,
      vendorAccountId: purchase.vendorAccountId,
    })
    .from(purchase)
    .where(inArray(purchase.id, [...purchaseIds]));
  const accounts = await browsingAccounts(
    db,
    owners.flatMap((row) => (row.vendorId ? [row.vendorId] : [])),
  );
  const vendorAccountIds = owners.flatMap(({ vendorId, vendorAccountId }) => {
    const account = vendorId
      ? browsingAccountFor(accounts, { vendorId, vendorAccountId })
      : null;
    return account ? [account.id] : [];
  });
  if (vendorAccountIds.length === 0) return null;
  return sweepPendingEnrichment(db, { vendorAccountIds });
}

/**
 * Recheck the sweep's earlier read inside the admission transaction: two
 * passes (cron and app open) or a member's manual start on another account
 * may have admitted a Product since. Product locks are taken in one order so
 * concurrent admissions over overlapping Products cannot deadlock.
 */
async function admitOpenProducts(
  tx: DrizzleTransaction,
  targets: TargetedRunTarget[],
): Promise<TargetedRunTarget[]> {
  const productIds = targets.flatMap((target) =>
    target.kind === "product" ? [target.productId] : [],
  );
  for (const id of [...productIds].sort())
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`product-enrichment:${id}`}))`,
    );
  const open = await openProducts(tx, productIds);
  return targets.filter(
    (target) => target.kind === "product" && open.has(target.productId),
  );
}

/**
 * Of these Products, the ones no enrichment run has committed or skipped,
 * none is working now, and fewer than `MAX_ENRICHMENT_ATTEMPTS` runs ended
 * without either.
 */
async function openProducts(
  db: Database | DrizzleTransaction,
  productIds: readonly string[],
) {
  if (productIds.length === 0) return new Set<string>();
  const attempts = await unwrapDb(db)
    .select({
      productId: runTarget.entityId,
      state: runTarget.state,
      status: runTable.status,
    })
    .from(runTarget)
    .innerJoin(runTable, eq(runTable.id, runTarget.runId))
    .where(
      and(
        eq(runTable.purpose, "product_enrichment"),
        eq(runTarget.entityKind, "product"),
        inArray(runTarget.entityId, [...productIds]),
      ),
    );
  // A dispatch_failed run is not retried by itself, so it is a spent
  // attempt rather than one still working the Product.
  const holding = new Set<string>(ACTIVE_RUN_STATUSES);
  const settled = new Set<string>();
  const tries = new Map<string, number>();
  for (const attempt of attempts) {
    if (
      attempt.state === "completed" ||
      attempt.state === "skipped" ||
      holding.has(attempt.status)
    )
      settled.add(attempt.productId);
    tries.set(attempt.productId, (tries.get(attempt.productId) ?? 0) + 1);
  }
  return new Set(
    productIds.filter(
      (id) =>
        !settled.has(id) && (tries.get(id) ?? 0) < MAX_ENRICHMENT_ATTEMPTS,
    ),
  );
}

/**
 * Every Purchase line of each open Product a purchase import created within
 * the window: oldest Product first, and within one Product the lines with a
 * product page first, then by page and Purchase so the choice is stable.
 */
async function pendingCandidates(db: Database, since: Date) {
  const rows = await getDb(db)
    .selectDistinct({
      productId: product.id,
      createdAt: product.createdAt,
      url: expense.url,
      purchaseId: purchase.id,
      vendorId: purchase.vendorId,
      vendorAccountId: purchase.vendorAccountId,
    })
    .from(product)
    .innerJoin(
      auditLog,
      and(
        eq(auditLog.entityId, product.id),
        eq(auditLog.entityKind, "product"),
        eq(auditLog.action, "create"),
        isNotNull(auditLog.runId),
        gte(auditLog.createdAt, since),
      ),
    )
    .innerJoin(
      runTable,
      and(
        eq(runTable.id, auditLog.runId),
        eq(runTable.purpose, "account_sync"),
      ),
    )
    .innerJoin(
      expense,
      and(eq(expense.productId, product.id), notDeleted(expense)),
    )
    .innerJoin(
      purchase,
      and(eq(purchase.id, expense.purchaseId), notDeleted(purchase)),
    )
    .where(notDeleted(product));
  const open = await openProducts(
    db,
    rows.map((row) => row.productId),
  );
  const order = (left: string | null, right: string | null) =>
    (left ?? "").localeCompare(right ?? "");
  return rows
    .flatMap(({ vendorId, ...row }) =>
      vendorId && open.has(row.productId) ? [{ ...row, vendorId }] : [],
    )
    .sort(
      (left, right) =>
        left.createdAt.getTime() - right.createdAt.getTime() ||
        order(left.productId, right.productId) ||
        Number(left.url === null) - Number(right.url === null) ||
        order(left.url, right.url) ||
        order(left.purchaseId, right.purchaseId),
    );
}
