import type {
  ProductId,
  PurchaseId,
  RunId,
  VendorAccountId,
} from "@cubby/schemas/identifiers";
import {
  type AnyColumn,
  and,
  eq,
  gte,
  inArray,
  or,
  type SQL,
  sql,
} from "drizzle-orm";

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
  const byAccount = groupByAccount(
    candidates,
    accounts,
    options.vendorAccountIds,
  );
  for (const { account, products } of byAccount.values()) {
    if (options.bridge && !(await options.bridge.connected(account.id))) {
      result.waiting.push({ vendorAccountId: account.id, reason: "offline" });
      continue;
    }
    const targets = await selectTargets(db, account, products);
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

type Candidate = Awaited<ReturnType<typeof pendingCandidates>>[number];
type Account = Awaited<ReturnType<typeof browsingAccounts>>[number];

/**
 * In memory only: a Product goes to the account of its first line whose
 * Vendor browses, keeping that account's lines (product page first) for the
 * start page, which is resolved only once the account can run.
 */
function groupByAccount(
  candidates: readonly Candidate[],
  accounts: readonly Account[],
  only: readonly VendorAccountId[] | undefined,
) {
  const byAccount = new Map<
    VendorAccountId,
    { account: Account; products: Map<ProductId, (string | null)[]> }
  >();
  const owner = new Map<ProductId, VendorAccountId>();
  for (const row of candidates) {
    const account = browsingAccountFor(accounts, row);
    if (!account || (only && !only.includes(account.id))) continue;
    const assigned = owner.get(row.productId);
    if (assigned && assigned !== account.id) continue;
    owner.set(row.productId, account.id);
    const group = byAccount.get(account.id) ?? {
      account,
      products: new Map(),
    };
    group.products.set(row.productId, [
      ...(group.products.get(row.productId) ?? []),
      row.url,
    ]);
    byAccount.set(account.id, group);
  }
  return byAccount;
}

/**
 * Up to `TARGETS_PER_RUN` targets, resolving start pages one Product at a
 * time: the first line page on the Vendor's browser domains, else a learned
 * page or the Vendor's website. A Product with none waits for a domain or
 * website on its Vendor.
 */
async function selectTargets(
  db: Database,
  account: Account,
  products: ReadonlyMap<ProductId, (string | null)[]>,
) {
  const targets = [];
  for (const [id, pages] of products) {
    if (targets.length === TARGETS_PER_RUN) break;
    const startUrl = await enrichmentStartPage(db, {
      productId: id,
      vendorId: account.vendorId,
      pages,
    });
    const live = startUrl ? await productEnrichmentTarget(getDb(db), id) : null;
    if (!startUrl || !live) continue;
    targets.push({
      kind: "product" as const,
      productId: id,
      vendorAccountId: account.id,
      sourceExternalKey: startUrl,
      targetFingerprint: live.fingerprint,
    });
  }
  return targets;
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
 * Recheck the sweep's earlier read inside the admission transaction, after
 * `startTargetedRun` has locked the Products and dropped any an active run
 * holds: a racing pass may have spent a Product's last attempt or finished
 * it since.
 */
async function admitOpenProducts(
  tx: DrizzleTransaction,
  targets: TargetedRunTarget[],
): Promise<TargetedRunTarget[]> {
  const open = await openProducts(
    tx,
    targets.flatMap((target) =>
      target.kind === "product" ? [target.productId] : [],
    ),
  );
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

/** An audit row this entity got from a purchase-import (account_sync) Run. */
const importRunTouched = (
  entityKind: "product" | "purchase",
  entityId: SQL | AnyColumn,
) =>
  sql`EXISTS (
    SELECT 1 FROM ${auditLog}
    INNER JOIN ${runTable} ON ${runTable.id} = ${auditLog.runId}
      AND ${runTable.purpose} = 'account_sync'
    WHERE ${auditLog.entityKind} = ${entityKind}
      AND ${auditLog.entityId} = ${entityId}
      ${entityKind === "product" ? sql`AND ${auditLog.action} = 'create'` : sql``}
  )`;

/**
 * Every Purchase line of each open Product a purchase import created within
 * the window: oldest Product first, and within one Product the lines with a
 * product page first, then by page and Purchase so the choice is stable.
 *
 * A Product is import-created when its `create` audit row names an import
 * Run, or, for imports from before the writer recorded the Products it
 * created (no `create` row at all), when it was created in the window and
 * bought on a Purchase an import Run wrote.
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
      expense,
      and(eq(expense.productId, product.id), notDeleted(expense)),
    )
    .innerJoin(
      purchase,
      and(eq(purchase.id, expense.purchaseId), notDeleted(purchase)),
    )
    .where(
      and(
        notDeleted(product),
        gte(product.createdAt, since),
        or(
          importRunTouched("product", product.id),
          // Only a Product with no create row at all (an import before the
          // writer recorded them) falls back to its Purchase's import Run; a
          // Product created by hand or from photos keeps that provenance.
          and(
            sql`NOT EXISTS (
              SELECT 1 FROM ${auditLog}
              WHERE ${auditLog.entityKind} = 'product'
                AND ${auditLog.entityId} = ${product.id}
                AND ${auditLog.action} = 'create'
            )`,
            importRunTouched("purchase", purchase.id),
          ),
        ),
      ),
    );
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
