/**
 * A synthetic domain module for the kernel's dangerous-rule tests: two
 * evidence kinds (statement charges and order receipts), one money
 * reconciler that books a purchase per order reference, one catalog
 * reconciler that fills the purchase's category, and one model ask. Its
 * tables live in their own schema so they never enter the public catalog.
 */
import { sourceActor } from "@cubby/schemas/kernel/stage";
import { eq, inArray, sql } from "drizzle-orm";
import { integer, pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { z } from "zod";

import type { Database } from "~/server/db/database";
import { repositoryQueries } from "~/server/db/repository-access.boundary";
import {
  defineAsk,
  defineEvidence,
  defineModule,
  defineReconciler,
  bindingWrites,
  recordSubject,
  source,
  writes,
} from "~/server/kernel/api";

const fixture = pgSchema("kernel_fixture");

export const fixtureCharge = fixture.table("FixtureCharge", {
  id: uuid("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  sourceRef: text("sourceRef").notNull().unique(),
  orderRef: text("orderRef").notNull(),
  amountMinor: integer("amountMinor").notNull(),
  createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
});

export const fixtureReceipt = fixture.table("FixtureReceipt", {
  id: uuid("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  sourceRef: text("sourceRef").notNull().unique(),
  orderRef: text("orderRef").notNull(),
  amountMinor: integer("amountMinor").notNull(),
  merchant: text("merchant"),
  categoryHint: text("categoryHint"),
  owner: text("owner"),
  createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
});

export const fixturePurchase = fixture.table("FixturePurchase", {
  id: uuid("id").primaryKey(),
  orderRef: text("orderRef").notNull(),
  amountMinor: integer("amountMinor").notNull(),
  merchant: text("merchant"),
  receiptId: uuid("receiptId").references(() => fixtureReceipt.id),
  category: text("category"),
  deletedAt: timestamp("deletedAt", { mode: "date" }),
  createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updatedAt", { mode: "date" }).notNull().defaultNow(),
});

export const fixtureExpense = fixture.table("FixtureExpense", {
  id: uuid("id").primaryKey(),
  purchaseId: uuid("purchaseId")
    .notNull()
    .references(() => fixturePurchase.id),
  amountMinor: integer("amountMinor").notNull(),
});
export const fixtureAllocation = fixture.table("FixtureAllocation", {
  id: uuid("id").primaryKey(),
  purchaseId: uuid("purchaseId")
    .notNull()
    .references(() => fixturePurchase.id),
  expenseId: uuid("expenseId")
    .notNull()
    .references(() => fixtureExpense.id),
  amountMinor: integer("amountMinor").notNull(),
});

/** Create the fixture schema once per database and empty it for each test. */
export async function resetFixtureTables(db: Database): Promise<void> {
  // One statement per call: the query tracer reads one result per statement.
  for (const statement of [
    `CREATE SCHEMA IF NOT EXISTS kernel_fixture`,
    `CREATE TABLE IF NOT EXISTS kernel_fixture."FixtureCharge" (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "sourceRef" text NOT NULL UNIQUE,
      "orderRef" text NOT NULL,
      "amountMinor" integer NOT NULL,
      "createdAt" timestamp NOT NULL DEFAULT now())`,
    `CREATE TABLE IF NOT EXISTS kernel_fixture."FixtureReceipt" (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "sourceRef" text NOT NULL UNIQUE,
      "orderRef" text NOT NULL,
      "amountMinor" integer NOT NULL,
      merchant text,
      "categoryHint" text,
      owner text,
      "createdAt" timestamp NOT NULL DEFAULT now())`,
    `CREATE TABLE IF NOT EXISTS kernel_fixture."FixturePurchase" (
      id uuid PRIMARY KEY,
      "orderRef" text NOT NULL,
      "amountMinor" integer NOT NULL,
      merchant text,
      "receiptId" uuid REFERENCES kernel_fixture."FixtureReceipt"(id),
      category text,
      "deletedAt" timestamp,
      "createdAt" timestamp NOT NULL DEFAULT now(),
      "updatedAt" timestamp NOT NULL DEFAULT now())`,
    `CREATE TABLE IF NOT EXISTS kernel_fixture."FixtureExpense" (id uuid PRIMARY KEY, "purchaseId" uuid NOT NULL REFERENCES kernel_fixture."FixturePurchase"(id), "amountMinor" integer NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS kernel_fixture."FixtureAllocation" (id uuid PRIMARY KEY, "purchaseId" uuid NOT NULL REFERENCES kernel_fixture."FixturePurchase"(id), "expenseId" uuid NOT NULL REFERENCES kernel_fixture."FixtureExpense"(id), "amountMinor" integer NOT NULL)`,
    `DELETE FROM kernel_fixture."FixtureAllocation"`,
    `DELETE FROM kernel_fixture."FixtureExpense"`,
    `DELETE FROM kernel_fixture."FixturePurchase"`,
    `DELETE FROM kernel_fixture."FixtureCharge"`,
    `DELETE FROM kernel_fixture."FixtureReceipt"`,
  ])
    await repositoryQueries(db).execute(sql.raw(statement));
}

export const PURCHASE_SCOPE = "fixture.purchase";
export const CATEGORY_SCOPE = "fixture.category";
export const PURCHASE_TABLE = "FixturePurchase";

export const chargeEvidence = defineEvidence({
  kind: "fixture.charge",
  table: fixtureCharge,
  keys: (row) => [`order:${row.orderRef}`],
  discovers: (row) => [{ kind: PURCHASE_SCOPE, key: row.orderRef }],
});

export const receiptEvidence = defineEvidence({
  kind: "fixture.receipt",
  table: fixtureReceipt,
  keys: (row) => [
    `order:${row.orderRef}`,
    ...(row.merchant ? [`merchant:${row.merchant}`] : []),
  ],
  discovers: (row) => [{ kind: PURCHASE_SCOPE, key: row.orderRef }],
  owner: (row) => row.owner,
});

export type FixtureHooks = {
  predicateReceipts?: boolean;
  linked?: boolean;
  linkedDecision?: boolean;
  onRemove?: () => Promise<void>;
  disagreement?: () => string | null;
  /** Runs inside each `load`, before it reads; tests mutate inputs here. */
  onLoad?: (scope: string, keys: readonly string[]) => Promise<void>;
  /** Runs inside each `load`, after its reads and before the apply. */
  afterLoad?: (scope: string, keys: readonly string[]) => Promise<void>;
  /** The categorize producer; counts calls in tests. */
  categorize?: (merchant: string) => Promise<string>;
  /**
   * The purchase reconciler's version; version 2 upper-cases receipt
   * merchants and version 3 lower-cases them.
   */
  purchaseVersion?: number;
};

const newestFirst = <T extends { createdAt: Date }>(rows: readonly T[]) =>
  [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

/** The fixture module, with test hooks. */
export function fixtureModule(hooks: FixtureHooks = {}) {
  const version = hooks.purchaseVersion ?? 1;
  const categorize = defineAsk({
    feature: "fixture.categorize",
    producer: "model",
    promptVersion: "fixture-1",
    input: z.object({ merchant: z.string() }),
    output: z.object({ category: z.string() }),
    policy: { tier: "fast" },
    label: "a category",
    async produce(input, { db }) {
      const category = await (
        hooks.categorize ?? (async () => "Uncategorized")
      )(input.merchant);
      // The Answer's cost comes from the usage rows its call wrote.
      const { recordAiUsage } = await import("~/server/ai/usage");
      const { emitTelemetry } =
        await import("~/server/observability/telemetry");
      await recordAiUsage(
        db,
        {
          provider: "fixture",
          model: "fixture-model",
          feature: "fixture.categorize",
          operation: "fixture.categorize",
          chargedCost: 0.00001,
          durationMs: 1,
          transport: "gateway",
        },
        {
          emit: emitTelemetry,
          snapshot: async () => ({ amount: null, evidence: null }),
        },
      );
      return { output: { category }, model: "fixture-model", tier: "fast" };
    },
    estimateCostMicros: () => 10,
  });

  const purchaseWrites = writes(
    fixturePurchase,
    ["orderRef", "amountMinor", "merchant", "receiptId"],
    {
      discovers: (row) => [{ kind: CATEGORY_SCOPE, key: row.id }],
      ...(hooks.onRemove
        ? {
            remove: async (tx: Database, ids: readonly string[]) => {
              await hooks.onRemove!();
              await repositoryQueries(tx)
                .update(fixturePurchase)
                .set({ deletedAt: new Date() })
                .where(inArray(fixturePurchase.id, [...ids]));
            },
          }
        : {}),
      // The absorbed purchase is retired; the kernel settles who owns the survivor.
      merge: async (tx, { loserIds }) => {
        await repositoryQueries(tx)
          .update(fixturePurchase)
          .set({ deletedAt: new Date() })
          .where(inArray(fixturePurchase.id, [...loserIds]));
      },
    },
  );
  const categoryWrites = writes(fixturePurchase, ["category"]);
  const expenseWrites = writes(fixtureExpense, ["purchaseId", "amountMinor"]);
  const allocationWrites = writes(fixtureAllocation, [
    "purchaseId",
    "expenseId",
    "amountMinor",
  ]);

  const purchase = defineReconciler<{
    orderRef: string;
    /** Own charges bind to this order's event; charges merged in arrive bound. */
    charges: (typeof fixtureCharge.$inferSelect)[];
    bound: (typeof fixtureCharge.$inferSelect)[];
    receipts: (typeof fixtureReceipt.$inferSelect)[];
  }>({
    scope: PURCHASE_SCOPE,
    lane: "money",
    version,
    reads: [
      source.evidence(chargeEvidence),
      source.evidence(receiptEvidence),
      source.bindings,
      source.table(fixtureCharge, ["orderRef", "amountMinor"]),
      ...(hooks.predicateReceipts
        ? [
            source.table(fixtureReceipt, [
              "orderRef",
              "amountMinor",
              "merchant",
            ]),
          ]
        : []),
    ],
    writes: [
      purchaseWrites,
      bindingWrites,
      ...(hooks.linked || hooks.linkedDecision
        ? [expenseWrites, allocationWrites]
        : []),
    ],
    async load(reads, keys) {
      await hooks.onLoad?.(PURCHASE_SCOPE, keys);
      const entries = await Promise.all(
        keys.map(async (key) => {
          const scoped = reads.for(key);
          const [charges, receipts, bindings] = await Promise.all([
            scoped.facts(chargeEvidence, [`order:${key}`]),
            hooks.predicateReceipts
              ? scoped
                  .select(fixtureReceipt, [], eq(fixtureReceipt.orderRef, key))
                  .then((rows) => new Map([[`order:${key}`, rows]]))
              : scoped.facts(receiptEvidence, [`order:${key}`]),
            scoped.bindings({ events: [key] }),
          ]);
          const own = charges.get(`order:${key}`) ?? [];
          const boundIds = bindings
            .filter((binding) => !own.some((row) => row.id === binding.fact.id))
            .map((binding) => binding.fact.id);
          const bound = [
            ...(await scoped.rows(fixtureCharge, boundIds)).values(),
          ];
          return [
            key,
            {
              orderRef: key,
              charges: newestFirst(own),
              bound,
              receipts: newestFirst(receipts.get(`order:${key}`) ?? []),
            },
          ] as const;
        }),
      );
      return new Map(entries);
    },
    reconcile(input, c) {
      for (const own of input.charges)
        c.bind({ kind: chargeEvidence.kind, id: own.id }, input.orderRef);
      const charge = newestFirst([...input.charges, ...input.bound])[0];
      const receipt = input.receipts[0];
      if (!charge && !receipt) {
        for (const key of c.existing(purchaseWrites))
          c.retire(purchaseWrites, key, "remove");
        return c.done();
      }
      const disagreement = hooks.disagreement?.();
      if (disagreement) c.disagree(disagreement);
      const id = c.recordId(purchaseWrites, "event");
      const assigned = id
        ? (c.assignments(recordSubject(PURCHASE_TABLE, id)).get("merchant") ??
          null)
        : null;
      const observed = receipt?.merchant ?? null;
      const merchant = assigned
        ? assigned.kind === "set"
          ? String(assigned.value)
          : null
        : observed && version >= 3
          ? observed.toLowerCase()
          : observed && version >= 2
            ? observed.toUpperCase()
            : observed;
      const purchaseId = c.record(
        purchaseWrites,
        "event",
        {
          orderRef: input.orderRef,
          amountMinor: charge?.amountMinor ?? receipt!.amountMinor,
          merchant,
          receiptId: receipt?.id ?? null,
        },
        { provenance: assigned ? { merchant: assigned.id } : {} },
      );
      const linked = id
        ? c.decision("assignment", recordSubject(PURCHASE_TABLE, id), "linked")
        : null;
      // A member's link also binds the order's charges on the decision basis.
      if (hooks.linkedDecision && linked?.value === true)
        for (const own of input.charges)
          c.bind(
            { kind: chargeEvidence.kind, id: own.id },
            input.orderRef,
            "decision",
          );
      if (hooks.linked || (hooks.linkedDecision && linked?.value === true)) {
        const provenance = (target: typeof expenseWrites, fields: string[]) =>
          linked &&
          !c.recordId(
            target,
            target === expenseWrites ? "expense" : "allocation",
          )
            ? Object.fromEntries(fields.map((field) => [field, linked.id]))
            : {};
        const expenseId = c.record(
          expenseWrites,
          "expense",
          {
            purchaseId,
            amountMinor: charge?.amountMinor ?? receipt!.amountMinor,
          },
          {
            provenance: provenance(expenseWrites, [
              "purchaseId",
              "amountMinor",
            ]),
          },
        );
        c.record(
          allocationWrites,
          "allocation",
          {
            purchaseId,
            expenseId,
            amountMinor: charge?.amountMinor ?? receipt!.amountMinor,
          },
          {
            provenance: provenance(allocationWrites, [
              "purchaseId",
              "expenseId",
              "amountMinor",
            ]),
          },
        );
      }
      if (!receipt)
        c.gap.evidence("the order receipt", sourceActor("Synthetic mailbox"));
      const desired = c.done();
      return hooks.linked
        ? { ...desired, records: [...desired.records].reverse() }
        : desired;
    },
  });

  const category = defineReconciler<{
    id: string;
    merchant: string | null;
    hints: string[];
  }>({
    scope: CATEGORY_SCOPE,
    lane: "catalog",
    version: 1,
    reads: [
      source.table(fixturePurchase, ["merchant", "category"]),
      source.evidence(receiptEvidence),
    ],
    writes: [categoryWrites],
    asks: [categorize],
    async load(reads, keys) {
      await hooks.onLoad?.(CATEGORY_SCOPE, keys);
      const entries = await Promise.all(
        keys.map(async (key) => {
          const scoped = reads.for(key);
          const row = (await scoped.rows(fixturePurchase, [key])).get(key);
          const merchant = row?.merchant ?? null;
          const hints = merchant
            ? ((
                await scoped.facts(receiptEvidence, [`merchant:${merchant}`])
              ).get(`merchant:${merchant}`) ?? [])
            : [];
          return [
            key,
            {
              id: key,
              merchant,
              hints: hints.flatMap((hint) =>
                hint.categoryHint ? [hint.categoryHint] : [],
              ),
            },
          ] as const;
        }),
      );
      await hooks.afterLoad?.(CATEGORY_SCOPE, keys);
      return new Map(entries);
    },
    reconcile(input, c) {
      if (!input.merchant) {
        c.gap.evidence("the merchant", sourceActor("Synthetic mailbox"));
        return c.done();
      }
      const subject = recordSubject(PURCHASE_TABLE, input.id);
      const assigned = c.decision("assignment", subject, "category");
      const vetoed = new Set(
        (c.decision("veto", subject, "category")?.values ?? []).map(String),
      );
      let value: string | null = null;
      if (assigned)
        value = assigned.kind === "set" ? String(assigned.value) : null;
      else if (input.hints[0]) value = input.hints[0];
      else {
        const answer = c.answer(categorize, { merchant: input.merchant });
        if (answer.status === "answered") value = answer.output.category;
      }
      if (value !== null && vetoed.has(value)) {
        c.gap.decision(`a category other than ${value}`);
        value = null;
      }
      c.patch(categoryWrites, input.id, { category: value });
      return c.done();
    },
  });

  return {
    module: defineModule({
      name: "fixture",
      evidence: [chargeEvidence, receiptEvidence],
      asks: [categorize],
      reconcilers: [purchase, category],
      machinery: [
        {
          entity: PURCHASE_TABLE,
          owning: PURCHASE_SCOPE,
          scopes: [CATEGORY_SCOPE],
          fields: false,
          quality: false,
        },
      ],
    }),
    categorize,
    purchaseWrites,
    categoryWrites,
  };
}
