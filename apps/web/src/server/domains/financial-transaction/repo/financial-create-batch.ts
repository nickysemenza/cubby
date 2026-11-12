import type { ActorContext } from "@cubby/schemas/context";
import {
  type FinancialSpendingPlan,
  type financialSpendingRequest,
} from "@cubby/schemas/financial-booking";
import type {
  FinancialTransactionCreateInput,
  FinancialTransactionUpdateData,
} from "@cubby/schemas/financial-transaction";
import type { FinancialTransactionSourceRef } from "@cubby/schemas/financial-transaction-fields";
import {
  type FinancialAccountId,
  type FinancialTransactionId,
  type FinancialTransactionShortcode,
  parseShortcodeFor,
  shortcodeSchema,
} from "@cubby/schemas/identifiers";
import { cents } from "@cubby/shared";
import { and, inArray } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import type { z } from "zod";

import { plainDateDaysBetween } from "~/lib/household-date";
import type { DrizzleTransaction } from "~/server/db";
import { databaseForTransaction, getDb, notDeleted } from "~/server/db/helpers";
import { relationalSql } from "~/server/db/helpers/relational-sql";
import { financialTransaction } from "~/server/db/schema";
import {
  financialSourceRefsFor,
  lockFreshFinancialSources,
} from "~/server/domains/financial-transaction/repo/financial-source-evidence";
import {
  type FinancialSpendingPage,
  prepareFinancialSpendingCandidates,
  prepareFinancialSpendingPage,
  previewFinancialSpendings,
  writeRecheckedSpendings,
} from "~/server/domains/financial-transaction/repo/financial-spending";
import {
  insertFreshFinancialTransactions,
  updateFinancialTransactions,
} from "~/server/domains/financial-transaction/repo/financial-transaction";
import { transactionDollars } from "~/server/domains/financial-transaction/repo/transaction-money";
import { WriteLayer } from "~/server/entity-kernel/repo/write-layer";

type SpendingRequest = z.input<typeof financialSpendingRequest>;
type SpendingAdvice = Pick<
  SpendingRequest,
  "advice" | "costType" | "beneficiaries"
>;

/** One fresh charge to create and, when it is spending, book. */
export type FinancialNewItem = {
  /** The caller's stable key (its Suggestion id). Core mints no operation id. */
  key: string;
  kind?: "create";
  accountId: FinancialAccountId;
  /** One accepted occurrence (`SOC-`) handle per source; no allocations. */
  create: Omit<
    FinancialTransactionCreateInput,
    "accountId" | "allocations" | "purchaseId"
  >;
  /** `null` creates settlement evidence only (transfer, card payment, income). */
  spending: SpendingAdvice | null;
};

/** One occurrence attached to an existing transaction, then booked like it. */
export type FinancialAttachItem = {
  key: string;
  kind: "attach";
  transactionId: FinancialTransactionId;
  /** The accepted occurrence (`SOC-`) handle. */
  sourceRef: FinancialTransactionSourceRef;
  /** Statement facts the review applies with the reference. */
  patch: Pick<
    FinancialTransactionUpdateData,
    "amount" | "status" | "postedDate"
  >;
  /** `null` attaches the evidence without booking. */
  spending: SpendingAdvice | null;
};

export type FinancialCreateItem = FinancialNewItem | FinancialAttachItem;

export type FinancialCreateOutcome =
  | {
      key: string;
      status: "booked";
      transactionId: FinancialTransactionShortcode;
      purchaseIds: string[];
    }
  /** Deferred spending, or settlement evidence only. */
  | {
      key: string;
      status: "created" | "attached";
      transactionId: FinancialTransactionShortcode;
    }
  /** Nothing was written for this item; apply it alone in a fresh transaction. */
  | { key: string; status: "declined"; reason: string };

/**
 * Facts for one dependency layer, read in the committing SERIALIZABLE
 * transaction after the caller's evidence locks. They serve planning and the
 * one apply in that transaction; nothing written by core precedes them.
 */
export type FinancialCreateFacts = {
  readonly tx: DrizzleTransaction;
  readonly items: readonly FinancialCreateItem[];
  readonly page: FinancialSpendingPage;
  plans?: (FinancialSpendingPlan | null)[];
  consumed: boolean;
};

/**
 * A charge whose plan changed between planning and its post-write recheck
 * in the same transaction. Its writes must not commit: roll the transaction
 * back and apply this item alone.
 */
export class FinancialCreateDivergenceError extends Error {
  constructor(
    readonly key: string,
    readonly detail: string,
  ) {
    super(`Spending for ${key} diverged after creation: ${detail}`);
    this.name = "FinancialCreateDivergenceError";
  }
}

export const DEPENDENT_CREATE =
  "dependent: shares a transaction, Vendor, Purchase, name or equal amount within 7 days with an earlier charge in this layer";

const isAttach = (item: FinancialCreateItem): item is FinancialAttachItem =>
  item.kind === "attach";

const sortedRefs = (refs: readonly FinancialTransactionSourceRef[]) =>
  [...refs].sort(
    (left, right) =>
      left.source.localeCompare(right.source) ||
      left.externalId.localeCompare(right.externalId),
  );

export async function loadFinancialCreateFacts(
  tx: DrizzleTransaction,
  items: readonly FinancialCreateItem[],
): Promise<FinancialCreateFacts> {
  const db = databaseForTransaction(tx);
  const creates = items.filter((item) => !isAttach(item));
  const attaches = items.filter(isAttach);
  const page = await prepareFinancialSpendingPage(db, {
    accountIds: [...new Set(creates.map((item) => item.accountId))],
    transactionIds: [...new Set(attaches.map((item) => item.transactionId))],
    sources: creates.flatMap((item) => (item.spending ? [item.create] : [])),
  });
  await prepareFinancialSpendingCandidates(
    db,
    page,
    items.flatMap((item) => {
      const name = item.spending?.advice?.vendorName;
      return name ? [name] : [];
    }),
  );
  return { tx, items, page, consumed: false };
}

/** A non-empty statement patch, as the attach preview projects it. */
const patchFields = (patch: FinancialAttachItem["patch"]) =>
  Object.keys(patch).length ? patch : undefined;

/**
 * Each item's spending plan, in item order: a create's on its prospective
 * source, an attach's on its target with the pending reference; `null` for
 * settlement-only items and for accounts or targets that are no longer live.
 * A ready plan's snapshot is the one the written transaction must reproduce.
 */
export async function planFinancialCreates(
  facts: FinancialCreateFacts,
): Promise<(FinancialSpendingPlan | null)[]> {
  if (facts.plans) return facts.plans;
  const planned: {
    index: number;
    request: Parameters<typeof previewFinancialSpendings>[1][number];
  }[] = [];
  for (const [index, item] of facts.items.entries()) {
    if (!item.spending) continue;
    if (isAttach(item)) {
      const target = facts.page.transactions.get(item.transactionId);
      if (target)
        planned.push({
          index,
          request: {
            request: {
              transactionId: parseShortcodeFor(
                "financialTransaction",
                target.shortcode,
              ),
              ...item.spending,
            },
            attachment: {
              settlementRef: item.sourceRef,
              fields: patchFields(item.patch),
            },
          },
        });
      continue;
    }
    const account = facts.page.accounts.get(item.accountId);
    if (account)
      planned.push({
        index,
        request: {
          request: {
            source: {
              accountId: parseShortcodeFor(
                "financialAccount",
                account.shortcode,
              ),
              kind: item.create.kind,
              status: item.create.status,
              amount: item.create.amount,
              transactionDate: item.create.transactionDate,
              postedDate: item.create.postedDate,
              merchant: item.create.merchant,
              rawDescription: item.create.rawDescription,
              sourceRefs: item.create.sourceRefs,
            },
            ...item.spending,
          },
        },
      });
  }
  const plans = await previewFinancialSpendings(
    databaseForTransaction(facts.tx),
    planned.map(({ request }) => request),
    facts.page,
  );
  const result: (FinancialSpendingPlan | null)[] = facts.items.map(() => null);
  for (const [position, { index }] of planned.entries())
    result[index] = plans[position]!;
  facts.plans = result;
  return result;
}

const folded = (value: string | null | undefined) =>
  value?.trim().replace(/\s+/g, " ").toLowerCase() || null;

/** The charge facts dependency keys and occurrence proofs read. */
type Charge = {
  item: FinancialCreateItem;
  plan: FinancialSpendingPlan | null;
  accountId: FinancialAccountId;
  amount: number;
  date: string | null;
  merchant: string | null;
  rawDescription: string | null;
  refs: readonly FinancialTransactionSourceRef[];
  target: FinancialSpendingPage["transactions"] extends Map<string, infer Row>
    ? Row | null
    : never;
};

/**
 * The keys through which one ready booking's plan can read another's writes:
 * its Vendor, its Purchase, the raw and cleaned names Vendor resolution
 * reads, and its amount and date. Settlement-only and deferred items write
 * nothing a booking plan reads beyond what it already sees before the write.
 */
function dependencyKeys(charge: Charge) {
  const { plan } = charge;
  if (plan?.status !== "ready") return null;
  return {
    vendor: plan.vendorId ?? folded(plan.vendorName),
    purchase: plan.purchaseId ?? null,
    names: [
      folded(charge.merchant) ?? folded(charge.rawDescription),
      folded(plan.vendorName),
    ].filter((name): name is string => Boolean(name && name.length >= 3)),
    amount: cents(charge.amount),
    date: charge.date,
  };
}

function dependsOn(
  later: NonNullable<ReturnType<typeof dependencyKeys>>,
  earlier: NonNullable<ReturnType<typeof dependencyKeys>>,
) {
  if (later.vendor && later.vendor === earlier.vendor) return true;
  if (later.purchase && later.purchase === earlier.purchase) return true;
  if (
    later.amount === earlier.amount &&
    later.date &&
    earlier.date &&
    Math.abs(plainDateDaysBetween(earlier.date, later.date)) <= 7
  )
    return true;
  return later.names.some((name) =>
    earlier.names.some((other) => name.includes(other) || other.includes(name)),
  );
}

/** The item's charge facts, or a refusal decided before any write. */
function chargeOf(
  facts: FinancialCreateFacts,
  item: FinancialCreateItem,
  plan: FinancialSpendingPlan | null,
): Charge | { refusal: string } {
  const refs = isAttach(item) ? [item.sourceRef] : item.create.sourceRefs;
  if (
    refs.some(
      (ref) =>
        !shortcodeSchema("sourceOccurrence").safeParse(ref.externalId).success,
    )
  )
    throw new Error("Batch items name accepted occurrence handles only");
  if (isAttach(item)) {
    const target = facts.page.transactions.get(item.transactionId);
    if (!target)
      return { refusal: "The attached transaction is no longer live." };
    if (
      item.patch.amount !== undefined &&
      facts.page.allocations.get(target.id)?.length
    )
      return {
        refusal:
          "An amount correction on settled spending re-allocates it; apply it alone.",
      };
    return {
      item,
      plan,
      accountId: target.accountId,
      amount: item.patch.amount ?? target.amount,
      date:
        target.transactionDate ?? item.patch.postedDate ?? target.postedDate,
      merchant: target.merchant,
      rawDescription: target.rawDescription,
      refs,
      target,
    };
  }
  if (!facts.page.accounts.get(item.accountId))
    return { refusal: "The spending account is no longer live." };
  return {
    item,
    plan,
    accountId: item.accountId,
    amount: item.create.amount,
    date: item.create.transactionDate ?? item.create.postedDate,
    merchant: item.create.merchant,
    rawDescription: item.create.rawDescription,
    refs,
    target: null,
  };
}

/** A refusal for a plan that cannot be written as part of the layer. */
function planRefusal(
  item: FinancialCreateItem,
  plan: FinancialSpendingPlan | null,
) {
  if (!item.spending) return null;
  if (!plan) return "The attached transaction is no longer live.";
  if (plan.status === "review_required")
    return `Spending needs review: ${plan.reason}`;
  if (plan.status === "already_booked" && !isAttach(item))
    return "The prospective charge is already booked.";
  if (plan.status === "ready" && !plan.purchaserSnapshot)
    return "Spending purchaser proof is missing; refresh the booking and review again.";
  return null;
}

/**
 * Create or attach, then book, one independent layer in page order. Every
 * refusal is decided before any write and returned as `declined`; an item
 * that depends on an earlier admitted item (the same target, or a shared
 * booking key) is declined as `DEPENDENT_CREATE`. A plan that changes after
 * the write throws `FinancialCreateDivergenceError`. The caller holds the
 * evidence-source and occurrence advisory locks and every attach target's
 * transaction-source lock; fresh transactions need no reviewed-booking lock
 * because no other transaction can name them.
 */
export async function applyFinancialCreates(
  tx: DrizzleTransaction,
  facts: FinancialCreateFacts,
  admitted: readonly string[],
  actor: ActorContext,
): Promise<FinancialCreateOutcome[]> {
  if (facts.tx !== tx || facts.consumed)
    throw new Error(
      "Financial create facts serve one apply in the transaction that loaded them",
    );
  facts.consumed = true;
  const db = databaseForTransaction(tx);
  const plans = await planFinancialCreates(facts);
  const wanted = new Set(admitted);
  const outcomes = new Map<string, FinancialCreateOutcome>();
  const decline = (key: string, reason: string) =>
    outcomes.set(key, { key, status: "declined", reason });

  const charges: Charge[] = [];
  const kept: NonNullable<ReturnType<typeof dependencyKeys>>[] = [];
  const targets = new Set<string>();
  for (const [index, item] of facts.items.entries()) {
    if (!wanted.has(item.key)) continue;
    const plan = plans[index] ?? null;
    const charge = chargeOf(facts, item, plan);
    if ("refusal" in charge) {
      decline(item.key, charge.refusal);
      continue;
    }
    const refusal = planRefusal(item, plan);
    if (refusal) {
      decline(item.key, refusal);
      continue;
    }
    const keys = dependencyKeys(charge);
    if (
      (charge.target && targets.has(charge.target.id)) ||
      (keys && kept.some((earlier) => dependsOn(keys, earlier)))
    ) {
      decline(item.key, DEPENDENT_CREATE);
      continue;
    }
    if (charge.target) targets.add(charge.target.id);
    if (keys) kept.push(keys);
    charges.push(charge);
  }

  const proof = await lockFreshFinancialSources(
    tx,
    charges.map(({ refs, accountId, amount }) => ({ refs, accountId, amount })),
  );
  const proven = charges.filter(({ item }, index) => {
    const refusal = proof.refusals[index];
    if (refusal) decline(item.key, refusal);
    return !refusal;
  });
  const creates = proven.filter(({ item }) => !isAttach(item));
  const attaches = proven.filter(({ item }) => isAttach(item));

  const layer = new WriteLayer(tx);
  const created = await insertFreshFinancialTransactions(
    layer,
    creates.map(({ item }) => {
      if (isAttach(item)) throw new Error("A create item was expected");
      return {
        data: { ...item.create, allocations: [], purchaseId: null },
        accountId: item.accountId,
      };
    }),
    proof.owners,
    actor,
  );
  await updateFinancialTransactions(
    db,
    attaches.map(({ item, target }) => {
      if (!isAttach(item) || !target) throw new Error("An attach was expected");
      return {
        shortcode: parseShortcodeFor("financialTransaction", target.shortcode),
        data: {
          sourceRefs: sortedRefs([
            ...(facts.page.references.get(target.id) ?? []),
            item.sourceRef,
          ]),
          ...item.patch,
        },
      };
    }),
    actor,
  );
  const written = [
    ...creates.map((charge, index) => ({ charge, id: created[index]!.id })),
    ...attaches.map((charge) => ({ charge, id: charge.target!.id })),
  ];

  // Every written transaction's row and references as the planner reads them.
  const rows = written.length
    ? (
        await getDb(db).query.financialTransaction.findMany({
          where: {
            RAW: (table: PgTable) =>
              relationalSql(
                table,
                and(
                  inArray(
                    financialTransaction.id,
                    written.map(({ id }) => id),
                  ),
                  notDeleted(financialTransaction),
                ),
              ),
          },
        })
      ).map(transactionDollars)
    : [];
  const codes = new Map(
    rows.map((row) => [
      row.id,
      parseShortcodeFor("financialTransaction", row.shortcode),
    ]),
  );
  for (const row of rows) {
    facts.page.transactions.set(row.id, row);
    facts.page.transactions.set(row.shortcode, row);
  }
  for (const [id, refs] of await financialSourceRefsFor(
    db,
    attaches.map(({ target }) => target!.id),
  ))
    facts.page.references.set(id, refs);
  for (const { charge, id } of written)
    if (!charge.target) facts.page.references.set(id, sortedRefs(charge.refs));
  for (const { charge, id } of written)
    if (!charge.plan || charge.plan.status !== "ready")
      outcomes.set(charge.item.key, {
        key: charge.item.key,
        status: charge.target ? "attached" : "created",
        transactionId: codes.get(id)!,
      });

  const spending = written.filter(({ charge }) => charge.plan);
  const fresh = await previewFinancialSpendings(
    db,
    spending.map(({ charge, id }) => ({
      request: { transactionId: codes.get(id)!, ...charge.item.spending },
    })),
    facts.page,
  );
  for (const [position, { charge }] of spending.entries()) {
    const plan = charge.plan!;
    const recheck = fresh[position]!;
    if (recheck.status !== plan.status)
      throw new FinancialCreateDivergenceError(
        charge.item.key,
        `planned ${plan.status}, rechecked ${recheck.status}`,
      );
    if (
      plan.status === "ready" &&
      (recheck.status !== "ready" || recheck.snapshot !== plan.snapshot)
    )
      throw new FinancialCreateDivergenceError(
        charge.item.key,
        "its evidence snapshot changed",
      );
  }
  const ready = spending.flatMap(({ charge, id }, position) =>
    charge.plan?.status === "ready"
      ? [
          {
            charge,
            plan: charge.plan,
            transactionId: codes.get(id)!,
            fresh: fresh[position]!,
          },
        ]
      : [],
  );
  // Fresh transactions book through the layer; attach targets are visible to
  // other writers and take the locked booking path.
  for (const group of [
    ready.filter(({ charge }) => !charge.target),
    ready.filter(({ charge }) => charge.target),
  ]) {
    if (!group.length) continue;
    const booked = await writeRecheckedSpendings(
      tx,
      group.map(({ plan, transactionId }) => ({ plan, transactionId })),
      group.map(({ fresh }) => fresh),
      facts.page,
      actor,
      group[0]!.charge.target ? undefined : layer,
    );
    for (const [position, { charge, transactionId }] of group.entries())
      outcomes.set(charge.item.key, {
        key: charge.item.key,
        status: "booked",
        transactionId,
        purchaseIds: booked[position]!.purchaseIds,
      });
  }
  await layer.flushAudits();
  return facts.items.flatMap((item) => {
    const outcome = outcomes.get(item.key);
    return outcome ? [outcome] : [];
  });
}
