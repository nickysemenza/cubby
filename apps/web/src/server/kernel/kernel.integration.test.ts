import { ledgerPartyId } from "@cubby/schemas/identifiers";
import { askProducer, kernelWaitCause } from "@cubby/schemas/kernel/machinery";
import { eq, inArray, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { beforeEach, describe, expect, it, vi } from "vitest";
/**
 * The kernel's dangerous rules (ADR 0029): order-independent convergence,
 * the `seq` and `rev` fences, claim expiry, never resending an unknown ask,
 * history protection, and decisions that outlive recomputation.
 */
import { z } from "zod";

import { insertFieldsFixture as insertWithShortcode } from "~/server/ai/fields/fields.fixtures";
import type { Database } from "~/server/db/database";
import { entityIdentity } from "~/server/db/entity-identity-schema";
import { manualEntry, evidenceBinding, drift } from "~/server/db/kernel-schema";
import { registerOwnedColumns } from "~/server/db/owned-columns";
import {
  repositoryQueries,
  repositoryTransactionDatabase,
} from "~/server/db/repository-access.boundary";
import {
  auditLog,
  ledgerParty,
  transactionImport,
  vendor,
  financialTransaction,
  expense,
} from "~/server/db/schema";
import { manualTransactionEvidence } from "~/server/domains/financial-transaction/repo/manual-evidence";
import { createPurchaseEventRecord } from "~/server/domains/financial-transaction/repo/purchase-event-mutations";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import { cancelRunWork } from "~/server/domains/run/repo/run-execution";
import { findPgError } from "~/server/errors/db-errors";
import { ensureExternalSources } from "~/server/generic/entity-links/repo/entity-external-ids";
import { WorkDeferredError } from "~/server/kernel/work-errors";
import * as backgroundTasks from "~/server/workflows/background-tasks/publish";

import {
  cancelRunAsks,
  retryRunAsks,
  createKernel,
  columnOwner,
  repointOwnedReference,
  defineModule,
  defineAsk,
  defineReconciler,
  source,
  defineEvidence,
  writes,
  definePass,
  evidenceRow,
  recordSubject,
  type Kernel,
} from "./api";
import { applyComputed, runClaimedScopes } from "./apply";
import {
  AskUnknownError,
  expireAsks,
  runQueuedAsks,
  settleAskOutcome,
} from "./ask";
import {
  releaseFundingWaits,
  renewScopeClaims,
  nextWakeSql,
  stopUnregisteredWork,
  claimAsk,
  claimAsks,
  releaseClaim,
  cancelClaimable,
  claimPass,
  ClaimLapsedError,
  claimScopes,
  fenceClaim,
} from "./claim";
import { computeBatch } from "./compute";
import { householdWrite } from "./gate";
import { runOnePass } from "./pass";
import { ownedColumns } from "./registry";
import {
  CATEGORY_SCOPE,
  chargeEvidence,
  fixtureCharge,
  fixtureModule,
  fixturePurchase,
  fixtureExpense,
  fixtureAllocation,
  fixtureReceipt,
  PURCHASE_SCOPE,
  PURCHASE_TABLE,
  receiptEvidence,
  resetFixtureTables,
  type FixtureHooks,
} from "./testing/kernel.fixtures";
import { ASK } from "./vocab";

const RUN = { budgetMs: 20_000 };

describe("evidence-facts kernel", () => {
  const ctx = withTestDb();
  beforeEach(async () => {
    await resetFixtureTables(ctx.db);
  });

  const kernelWith = (hooks: FixtureHooks = {}) => {
    const fixture = fixtureModule({
      categorize: async () => "Groceries",
      ...hooks,
    });
    const kernel = createKernel([fixture.module]);
    registerOwnedColumns(ownedColumns(kernel.registry));
    return { kernel, fixture };
  };
  it("parks unregistered work as Stuck and excludes it from the next wake", async () => {
    const { kernel } = kernelWith();
    const q = repositoryQueries(ctx.db);
    await q.execute(
      sql`INSERT INTO "ScopeDirty" ("scopeKind", "scopeKey", lane, reason) VALUES ('synthetic.removed', ${"scope"}, ${"money"}, 'synthetic')`,
    );
    await q.execute(
      sql`INSERT INTO "Ask" ("inputHash", feature, producer, "promptVersion", input) VALUES ('synthetic-removed', 'synthetic.removed', ${"model"}, '1', '{}')`,
    );
    await q.execute(
      sql`INSERT INTO "Pass" (name,key) VALUES ('synthetic.removed',${"default"})`,
    );
    await stopUnregisteredWork(ctx.db, kernel.registry);
    expect(
      (
        await q.execute<{ at: null }>(
          sql`SELECT ${nextWakeSql(kernel.registry)} AS at`,
        )
      ).rows,
    ).toEqual([{ at: null }]);
    expect(
      (
        await q.execute<{ stage: string; error: string }>(
          sql`SELECT stage,error FROM "ScopeState" WHERE "scopeKind"='synthetic.removed'`,
        )
      ).rows,
    ).toEqual([
      { stage: "stuck", error: "Unregistered reconciler: synthetic.removed" },
    ]);
    expect(
      (
        await q.execute<{ attempts: number; lastError: string }>(
          sql`SELECT attempts,"lastError" FROM "Ask" WHERE feature='synthetic.removed'`,
        )
      ).rows[0],
    ).toMatchObject({
      attempts: 3,
      lastError: "Unregistered Ask kind: synthetic.removed",
    });
    expect(
      (
        await q.execute<{ attempts: number; lastError: string }>(
          sql`SELECT attempts,"lastError" FROM "Pass" WHERE name='synthetic.removed'`,
        )
      ).rows[0],
    ).toMatchObject({
      attempts: 5,
      lastError: "Unregistered Pass: synthetic.removed",
    });
  });
  const charge = (
    orderRef: string,
    amountMinor: number,
    sourceRef = `stmt-${orderRef}-${amountMinor}`,
  ) => evidenceRow(chargeEvidence, { sourceRef, orderRef, amountMinor });
  const receipt = (
    orderRef: string,
    merchant: string,
    extra: { sourceRef?: string; categoryHint?: string } = {},
  ) =>
    evidenceRow(receiptEvidence, {
      sourceRef: extra.sourceRef ?? `mail-${orderRef}-${merchant}`,
      orderRef,
      amountMinor: 1250,
      merchant,
      categoryHint: extra.categoryHint ?? null,
    });
  const purchases = async (db: Database) =>
    repositoryQueries(db)
      .select()
      .from(fixturePurchase)
      .orderBy(fixturePurchase.orderRef);
  const dirtyCount = async (db: Database) =>
    Number(
      (
        await repositoryQueries(db).execute<{ n: number }>(
          sql`SELECT count(*)::int AS n FROM "ScopeDirty"`,
        )
      ).rows[0]!.n,
    );
  const settle = (kernel: Kernel) => kernel.run(ctx.db, RUN);

  it("dirties prepared roster readers when an empty declared table gains a row", async () => {
    const seen: number[] = [];
    const scope = { kind: "fixture.roster", key: "synthetic" };
    const reconciler = defineReconciler({
      scope: scope.kind,
      version: 1,
      lane: "catalog",
      reads: [source.history(fixtureReceipt, ["sourceRef"])],
      writes: [],
      async load(reads, keys) {
        return new Map(
          await Promise.all(
            keys.map(
              async (key) =>
                [
                  key,
                  await reads
                    .for(key)
                    .prepare(
                      [fixtureReceipt],
                      async (db) =>
                        (
                          await repositoryQueries(db)
                            .select()
                            .from(fixtureReceipt)
                        ).length,
                    ),
                ] as const,
            ),
          ),
        );
      },
      reconcile(count, c) {
        seen.push(count);
        return c.done();
      },
    });
    const module = fixtureModule();
    const kernel = createKernel([
      module.module,
      defineModule({ name: "roster", reconcilers: [reconciler] }),
    ]);
    await kernel.emitWrites(ctx.db, {
      table: fixtureReceipt,
      ids: [],
      columns: ["sourceRef"],
      discovers: [scope],
    });
    await kernel.reconcileNow(ctx.db, [scope]);
    expect(seen.at(-1)).toBe(0);
    await kernel.append(ctx.db, [
      receipt("SYNTHETIC-ROSTER", "Synthetic grocer"),
    ]);
    await kernel.emitWrites(ctx.db, {
      table: fixtureReceipt,
      ids: [],
      columns: ["sourceRef"],
    });
    await kernel.reconcileNow(ctx.db, [scope]);
    expect(seen.at(-1)).toBe(1);
  });

  it("reserves public codes during reconcile and retries a collision without leaking an identity", async () => {
    expect(await columnOwner(financialTransaction, "amount")).toBe("bankEvent");
    expect(
      await columnOwner(financialTransaction, "ledgerTransferId"),
    ).toBeNull();
    const target = writes(vendor, [], {
      entity: "vendor",
      createOnly: ["name"],
    });
    let retainedReference: string | null = null;
    const reconciler = defineReconciler<string>({
      scope: PURCHASE_SCOPE,
      lane: "money",
      version: 1,
      reads: [],
      writes: [target],
      load: async (_reads, keys) => new Map(keys.map((key) => [key, key])),
      reconcile(key, c) {
        const identity = c.identity(target, "seller");
        const id = c.record(
          target,
          "seller",
          { name: `Synthetic ${key}` },
          {
            provenance: retainedReference
              ? {
                  reference:
                    c.reference("vendor", retainedReference) ?? "missing",
                }
              : {},
          },
        );
        if (id !== identity.id)
          throw new Error("A declared record changed its reserved identity");
        return c.done();
      },
    });
    const kernel = createKernel([
      defineModule({
        name: "codes",
        evidence: [chargeEvidence],
        reconcilers: [reconciler],
      }),
    ]);
    await kernel.append(ctx.db, [charge("ORD-CODE", 1250)]);
    const q = repositoryQueries(ctx.db);
    const claimed = await claimScopes(q, kernel.registry, "money", 10);
    const computed = await computeBatch(
      q,
      kernel.registry,
      reconciler,
      [{ kind: PURCHASE_SCOPE, key: "ORD-CODE" }],
      { locked: false, hideBaseline: false },
    );
    const desired = computed[0]!.desired!.records[0]!;
    expect(desired.shortcode).toMatch(/^VEN-/);
    await q.insert(entityIdentity).values({
      id: crypto.randomUUID(),
      kind: "vendor",
      shortcode: desired.shortcode,
      deletedAt: new Date(),
    });
    expect(
      (
        await applyComputed(
          ctx.db,
          kernel.registry,
          reconciler,
          computed,
          claimed,
          { releaseBaseline: false, mode: "member" },
        )
      )[0]?.status,
    ).toBe("conflict");
    expect(
      await q
        .select()
        .from(entityIdentity)
        .where(eq(entityIdentity.id, desired.id)),
    ).toEqual([]);
    await settle(kernel);
    const [stored] = await q
      .select()
      .from(vendor)
      .where(eq(sql`${vendor.id}::text`, desired.id));
    expect(stored?.id).toBe(desired.id);
    expect(stored?.shortcode).toMatch(/^VEN-/);
    expect(stored?.shortcode).not.toBe(desired.shortcode);
    await q
      .update(entityIdentity)
      .set({ mergedIntoId: stored!.id })
      .where(eq(entityIdentity.shortcode, desired.shortcode!));
    retainedReference = desired.shortcode;
    await q
      .update(vendor)
      .set({ name: "Member catalog name" })
      .where(eq(vendor.id, stored!.id));
    await kernel.append(ctx.db, [charge("ORD-CODE", 1400)]);
    await settle(kernel);
    expect(
      (await q.select().from(vendor).where(eq(vendor.id, stored!.id)))[0]?.name,
    ).toBe("Member catalog name");
    const replay = await computeBatch(
      q,
      kernel.registry,
      reconciler,
      [{ kind: PURCHASE_SCOPE, key: "ORD-CODE" }],
      { locked: false, hideBaseline: false },
    );
    expect(replay[0]?.desired?.records[0]).toMatchObject({
      id: desired.id,
      shortcode: stored!.shortcode,
    });
    expect(replay[0]?.desired?.records[0]?.provenance.reference).toBe(
      stored!.id,
    );
  });

  it("reindexes evidence keys when a reviewed association moves and dirties both scopes", async () => {
    const { kernel } = kernelWith();
    await kernel.append(ctx.db, [
      charge("ORD-FROM", 1250),
      charge("ORD-TO", 1250),
      receipt("ORD-FROM", "Synthetic Seller"),
    ]);
    await settle(kernel);
    const [evidence] = await repositoryQueries(ctx.db)
      .select()
      .from(fixtureReceipt);
    await repositoryTransactionDatabase(ctx.db, async (tx) => {
      await repositoryQueries(tx)
        .update(fixtureReceipt)
        .set({ orderRef: "ORD-TO" })
        .where(eq(fixtureReceipt.id, evidence!.id));
      await kernel.emitWrites(tx, {
        table: fixtureReceipt,
        ids: [evidence!.id],
        columns: ["orderRef"],
      });
    });
    await settle(kernel);
    expect(
      (await purchases(ctx.db)).map((row) => [row.orderRef, row.merchant]),
    ).toEqual([
      ["ORD-FROM", null],
      ["ORD-TO", "Synthetic Seller"],
    ]);
    expect(
      await repositoryQueries(ctx.db).select().from(fixtureReceipt),
    ).toHaveLength(1);
  });

  it("keeps accepted baseline records and reports drift while applying a member's field decision", async () => {
    let disagreement: string | null = null;
    const { kernel } = kernelWith({
      linkedDecision: true,
      disagreement: () => disagreement,
    });
    const [fact] = await kernel.append(ctx.db, [charge("ORD-BASELINE", 1250)]);
    await settle(kernel);
    const [booked] = await purchases(ctx.db);
    await repositoryQueries(ctx.db).insert(evidenceBinding).values({
      factKind: fact!.kind,
      factId: fact!.id,
      eventKey: "ORD-BASELINE",
      basis: "baseline",
      scopeKind: PURCHASE_SCOPE,
      scopeKey: "ORD-BASELINE",
    });
    await repositoryQueries(ctx.db).execute(
      sql`UPDATE "ScopeState" SET version=0 WHERE "scopeKind"=${PURCHASE_SCOPE} AND "scopeKey"=${"ORD-BASELINE"}`,
    );
    await kernel.decide(ctx.db, ctx.actor, [
      {
        channel: "assignment",
        kind: "set",
        subject: recordSubject(PURCHASE_TABLE, booked!.id),
        field: "linked",
        value: true,
      },
      {
        channel: "assignment",
        kind: "set",
        subject: recordSubject(PURCHASE_TABLE, booked!.id),
        field: "merchant",
        value: "Member seller",
      },
    ]);
    await settle(kernel);
    expect((await purchases(ctx.db))[0]?.merchant).toBe("Member seller");
    expect(
      await repositoryQueries(ctx.db).select().from(fixtureExpense),
    ).toHaveLength(1);
    expect(
      await repositoryQueries(ctx.db).select().from(fixtureAllocation),
    ).toHaveLength(1);
    disagreement = "accepted allocation slices do not conserve the movement";
    await kernel.emitWrites(ctx.db, {
      table: fixtureCharge,
      ids: [fact!.id],
      columns: ["amountMinor"],
    });
    await settle(kernel);
    const [unresolved] = await repositoryQueries(ctx.db).select().from(drift);
    expect(unresolved?.difference).toMatchObject({
      disagreements: [disagreement],
    });
    expect(
      await kernel.approveDrift(
        ctx.db,
        ctx.actor,
        { kind: PURCHASE_SCOPE, key: "ORD-BASELINE" },
        unresolved!.proposalHash,
      ),
    ).toBe("stale");
    expect((await purchases(ctx.db))[0]?.amountMinor).toBe(1250);
    disagreement = null;
    await kernel.append(ctx.db, [charge("ORD-BASELINE", 1400)]);
    await settle(kernel);
    expect((await purchases(ctx.db))[0]).toMatchObject({
      id: booked!.id,
      amountMinor: 1250,
      merchant: "Member seller",
    });
    const [proposal] = await repositoryQueries(ctx.db).select().from(drift);
    expect(proposal).toMatchObject({
      scopeKind: PURCHASE_SCOPE,
      scopeKey: "ORD-BASELINE",
    });
    expect(
      (
        await kernel.machinery(ctx.db, ctx.actor, {
          entity: PURCHASE_TABLE,
          id: booked!.id,
        })
      ).drift,
    ).not.toBeNull();
  });

  it("dirties a negative predicate read when an authored row starts matching it", async () => {
    const { kernel } = kernelWith({ predicateReceipts: true });
    await kernel.append(ctx.db, [charge("ORD-PREDICATE", 1250)]);
    await settle(kernel);
    expect((await purchases(ctx.db))[0]?.merchant).toBeNull();
    await repositoryQueries(ctx.db).insert(fixtureReceipt).values({
      sourceRef: "synthetic-authored",
      orderRef: "ORD-PREDICATE",
      amountMinor: 1250,
      merchant: "Synthetic Seller",
    });
    await kernel.emitWrites(ctx.db, {
      table: fixtureReceipt,
      ids: [],
      columns: ["orderRef", "amountMinor", "merchant"],
      created: true,
    });
    await settle(kernel);
    expect((await purchases(ctx.db))[0]?.merchant).toBe("Synthetic Seller");
  });

  it("retains a manual observation once without rewriting its original payload", async () => {
    const kernel = createKernel([
      defineModule({ name: "manual", evidence: [manualTransactionEvidence] }),
    ]);
    const id = crypto.randomUUID();
    expect(
      await kernel.append(ctx.db, [
        evidenceRow(manualTransactionEvidence, {
          id,
          entity: "financialTransaction",
          userId: ctx.actor.userId,
          payload: { amount: 12.5 },
        }),
      ]),
    ).toEqual([{ kind: "manualEntry", id }]);
    expect(
      await kernel.append(ctx.db, [
        evidenceRow(manualTransactionEvidence, {
          id,
          entity: "financialTransaction",
          userId: ctx.actor.userId,
          payload: { amount: 30 },
        }),
      ]),
    ).toEqual([]);
    const [stored] = await repositoryQueries(ctx.db)
      .select()
      .from(manualEntry)
      .where(eq(manualEntry.id, id));
    expect(stored?.payload).toEqual({ amount: 12.5 });
  });

  it("creates linked records with stable ids in dependency order and leaks nothing on a fenced apply", async () => {
    let gateHeld = false;
    const { kernel, fixture } = kernelWith({
      linked: true,
      onRemove: async () => {
        const probe = await repositoryTransactionDatabase(ctx.db, (tx) =>
          repositoryQueries(tx).execute<{ acquired: boolean }>(
            sql`SELECT pg_try_advisory_xact_lock(hashtextextended('cubby:household-write', 0)) AS acquired`,
          ),
        );
        gateHeld = probe.rows[0]?.acquired === false;
      },
    });
    await kernel.append(ctx.db, [charge("ORD-LINKED", 1250)]);
    const q = repositoryQueries(ctx.db);
    const [claim] = await claimScopes(q, kernel.registry, "money", 10);
    const [first] = await computeBatch(
      q,
      kernel.registry,
      fixture.module.reconcilers[0]!,
      [{ kind: claim!.kind, key: claim!.key }],
      { locked: false, hideBaseline: false },
    );
    const [second] = await computeBatch(
      q,
      kernel.registry,
      fixture.module.reconcilers[0]!,
      [{ kind: claim!.kind, key: claim!.key }],
      { locked: false, hideBaseline: false },
    );
    expect(first!.desired?.records.map((record) => record.id)).toEqual(
      second!.desired?.records.map((record) => record.id),
    );
    await kernel.append(ctx.db, [charge("ORD-LINKED", 1400)]);
    expect(
      (
        await applyComputed(
          ctx.db,
          kernel.registry,
          fixture.module.reconcilers[0]!,
          [first!],
          [claim!],
          { releaseBaseline: false, mode: "member" },
        )
      )[0]?.status,
    ).toBe("conflict");
    expect(await purchases(ctx.db)).toEqual([]);
    expect(await q.select().from(fixtureExpense)).toEqual([]);
    expect(await q.select().from(fixtureAllocation)).toEqual([]);
    await settle(kernel);
    const [parent] = await purchases(ctx.db);
    const [line] = await q.select().from(fixtureExpense);
    const [allocation] = await q.select().from(fixtureAllocation);
    expect(line).toMatchObject({ purchaseId: parent!.id, amountMinor: 1400 });
    expect(allocation).toMatchObject({
      purchaseId: parent!.id,
      expenseId: line!.id,
      amountMinor: 1400,
    });
    expect(new Set([parent!.id, line!.id, allocation!.id]).size).toBe(3);
    expect(first!.desired?.records.map((record) => record.id).sort()).toEqual(
      [parent!.id, line!.id, allocation!.id].sort(),
    );
    await kernel.append(ctx.db, [receipt("ORD-LINKED", "Synthetic Grocer")]);
    await settle(kernel);
    expect((await purchases(ctx.db))[0]?.id).toBe(parent!.id);
    expect((await q.select().from(fixtureExpense))[0]?.id).toBe(line!.id);
    expect((await q.select().from(fixtureAllocation))[0]?.id).toBe(
      allocation!.id,
    );
    await kernel.decide(ctx.db, ctx.actor, [
      {
        channel: "rejection",
        kind: "reject",
        subject: `purchaseEvent:${parent!.id}`,
        scopes: [{ kind: PURCHASE_SCOPE, key: "ORD-LINKED" }],
      },
    ]);
    expect((await purchases(ctx.db))[0]?.deletedAt).toBeNull();
    await kernel.decide(ctx.db, ctx.actor, [
      {
        channel: "rejection",
        kind: "reject",
        subject: recordSubject(PURCHASE_TABLE, parent!.id),
      },
    ]);
    expect(gateHeld).toBe(true);
    expect((await purchases(ctx.db))[0]?.deletedAt).not.toBeNull();
  });

  it("reserves entity evidence atomically without leaking identities from a duplicate race", async () => {
    const evidence = defineEvidence({
      kind: "fixture.collection",
      table: transactionImport,
      entity: "transactionImport",
      keys: (row) => [`collection:${row.fingerprint}`],
      discovers: () => [],
    });
    const kernel = createKernel([
      defineModule({ name: "collection", evidence: [evidence] }),
    ]);
    await ensureExternalSources(ctx.db, ["synthetic-statement"]);
    const identities = () =>
      repositoryQueries(ctx.db)
        .select({ id: entityIdentity.id })
        .from(entityIdentity);
    const before = await identities();
    const row = evidenceRow(evidence, {
      source: "synthetic-statement",
      label: "Synthetic statement",
      fingerprint: "synthetic-collection",
    });
    const results = await Promise.all([
      kernel.append(ctx.db, [row]),
      kernel.append(ctx.db, [row]),
    ]);
    expect(results.flat()).toHaveLength(1);
    expect(await identities()).toHaveLength(before.length + 1);
    const [saved] = await repositoryQueries(ctx.db)
      .select()
      .from(transactionImport)
      .where(eq(transactionImport.fingerprint, "synthetic-collection"));
    expect(saved?.shortcode).toMatch(/^TIM-/);
    const [identity] = await repositoryQueries(ctx.db)
      .select()
      .from(entityIdentity)
      .where(eq(entityIdentity.id, saved!.id));
    expect(identity).toMatchObject({
      id: saved!.id,
      shortcode: saved!.shortcode,
      kind: "transactionImport",
    });
    expect(
      await kernel.append(ctx.db, [evidenceRow(evidence, saved!)]),
    ).toEqual([]);
    expect(await identities()).toHaveLength(before.length + 1);
    const [indexed] = (
      await repositoryQueries(ctx.db).execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM "FactKey" WHERE "factKind" = ${evidence.kind} AND "factId" = ${saved!.id}
    `)
    ).rows;
    expect(indexed?.n).toBe(1);
    await expect(
      kernel.append(ctx.db, [
        evidenceRow(evidence, {
          source: "missing-synthetic-source",
          label: "Synthetic invalid statement",
          fingerprint: "synthetic-invalid-collection",
        }),
      ]),
    ).rejects.toThrow(/TransactionImport/);
    expect(await identities()).toHaveLength(before.length + 1);
  });

  it("projects a member gap on its input record before the consumer creates an output", async () => {
    const seller = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic consumer seller",
    });
    const consumer = defineReconciler<null>({
      scope: "fixture.vendorConsumer",
      lane: "money",
      version: 1,
      reads: [source.table(vendor, ["name", "deletedAt"])],
      writes: [],
      async load(reads, keys) {
        await reads.rows(vendor, keys);
        return new Map(keys.map((key) => [key, null]));
      },
      reconcile(_input, c) {
        c.gap.decision("a reviewed identity");
        return c.done();
      },
    });
    const capability = {
      entity: "vendor",
      owning: null,
      scopes: [consumer.scope],
      fields: false,
      quality: false,
    } as const;
    const kernel = createKernel([
      defineModule({
        name: "consumer",
        reconcilers: [consumer],
        machinery: [capability],
      }),
    ]);
    await kernel.emitWrites(ctx.db, {
      table: vendor,
      ids: [seller.id],
      columns: ["name"],
      discovers: [{ kind: consumer.scope, key: seller.id }],
    });
    await settle(kernel);
    const read = await kernel.machinery(ctx.db, ctx.actor, {
      entity: "vendor",
      id: seller.id,
    });
    expect(read).toMatchObject({ stage: "needs_you", nextActor: "you" });
    expect(read.scopes.map((scope) => scope.kind)).toEqual([consumer.scope]);
    expect(
      (await kernel.listRows(ctx.db, capability, [seller.id])).get(seller.id),
    ).toMatchObject({ stage: "needs_you", firstGap: "a reviewed identity" });
    expect((await kernel.needsYou(ctx.db)).items).toEqual([
      expect.objectContaining({
        entity: "vendor",
        shortcode: seller.shortcode,
        firstGap: "a reviewed identity",
      }),
    ]);
  });

  it("coalesces declared Catalog creation across scopes and keeps each record's audit provenance", async () => {
    expect(() =>
      writes(vendor, ["name"], {
        createOnly: ["aliases"],
        coalesceCreation: (values) => values[0]!,
      }),
    ).toThrow("Only authored Catalog creations");
    const target = writes(vendor, [], {
      entity: "vendor",
      createOnly: ["name"],
      coalesceCreation: (values) => values[0]!,
    });
    const reconciler = defineReconciler<string>({
      scope: "fixture.sharedCreation",
      lane: "money",
      version: 1,
      reads: [],
      writes: [target],
      load: async (_reads, keys) => new Map(keys.map((key) => [key, key])),
      reconcile(_input, c) {
        c.record(target, "synthetic-shared", {
          name: "Synthetic shared batch Vendor",
        });
        return c.done();
      },
    });
    const kernel = createKernel([
      defineModule({ name: "sharedCreation", reconcilers: [reconciler] }),
    ]);
    const scopes = ["a", "b"].map((key) => ({ kind: reconciler.scope, key }));
    const result = await kernel.reconcileNow(ctx.db, scopes);
    expect(result.every((outcome) => outcome.status === "applied")).toBe(true);
    const rows = await repositoryQueries(ctx.db)
      .select()
      .from(vendor)
      .where(eq(vendor.name, "Synthetic shared batch Vendor"));
    expect(rows).toHaveLength(1);
    const metadata = await repositoryQueries(ctx.db).execute<{
      scopeKey: string;
      entityId: string;
    }>(
      sql`SELECT "scopeKey", "entityId" FROM "RecordKey" WHERE "scopeKind" = ${reconciler.scope} ORDER BY "scopeKey"`,
    );
    expect(metadata.rows).toEqual(
      scopes.map((scope) => ({ scopeKey: scope.key, entityId: rows[0]!.id })),
    );
    const audit = await repositoryQueries(ctx.db).execute<{
      provenance: { scope: { kind: string; key: string } };
    }>(
      sql`SELECT provenance FROM "AuditLog" WHERE "entityId" = ${rows[0]!.id}::uuid`,
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]?.provenance.scope.kind).toBe(reconciler.scope);
    await repositoryQueries(ctx.db)
      .update(vendor)
      .set({ name: "Synthetic member rename" })
      .where(eq(vendor.id, rows[0]!.id));
    await kernel.reconcileNow(ctx.db, [scopes[1]!, scopes[0]!]);
    expect(
      (
        await repositoryQueries(ctx.db)
          .select()
          .from(vendor)
          .where(eq(vendor.id, rows[0]!.id))
      )[0]?.name,
    ).toBe("Synthetic member rename");
    expect(
      (
        await repositoryQueries(ctx.db).execute<{ id: string }>(
          sql`SELECT id FROM "AuditLog" WHERE "entityId" = ${rows[0]!.id}::uuid`,
        )
      ).rows,
    ).toHaveLength(1);
  });

  it("applies several field patches to one row in a single fenced update", async () => {
    const original = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic original vendor",
    });
    const target = writes(vendor, ["name", "aliases"], { entity: "vendor" });
    const reconciler = defineReconciler({
      scope: "fixture.catalogPatches",
      lane: "catalog",
      version: 1,
      reads: [source.table(vendor, ["name", "aliases"])],
      writes: [target],
      load: (reads, keys) => reads.rows(vendor, keys),
      reconcile(row, c) {
        c.patch(target, row.id, { name: "Synthetic revised vendor" });
        c.patch(target, row.id, { aliases: ["Synthetic vendor alias"] });
        return c.done();
      },
    });
    const kernel = createKernel([
      defineModule({ name: "patches", reconcilers: [reconciler] }),
    ]);
    const scope = { kind: reconciler.scope, key: original.id };
    await kernel.emitWrites(ctx.db, {
      table: vendor,
      ids: [original.id],
      columns: ["name"],
      discovers: [scope],
    });
    expect((await kernel.reconcileNow(ctx.db, [scope]))[0]?.status).toBe(
      "applied",
    );
    expect(
      (
        await repositoryQueries(ctx.db)
          .select()
          .from(vendor)
          .where(eq(vendor.id, original.id))
      )[0],
    ).toMatchObject({
      name: "Synthetic revised vendor",
      aliases: ["Synthetic vendor alias"],
    });
    expect((await kernel.reconcileNow(ctx.db, [scope]))[0]?.status).toBe(
      "applied",
    );
    const audit = await repositoryQueries(ctx.db)
      .select({ provenance: auditLog.provenance })
      .from(auditLog)
      .where(eq(auditLog.entityId, original.id));
    expect(audit).toHaveLength(2);
    expect(
      audit.every(
        (entry) =>
          entry.provenance?.scope.kind === scope.kind &&
          entry.provenance.scope.key === scope.key,
      ),
    ).toBe(true);
  });

  it("resolves ledger-party evidence owners once per batch and hides unresolved owners", async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic evidence owner",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const fixture = fixtureModule({ categorize: async () => "Groceries" });
    const unknownOwner = crypto.randomUUID();
    const resolved: string[][] = [];
    const privateEvidence = {
      ...receiptEvidence,
      async resolveOwners(db: Database, keys: readonly string[]) {
        resolved.push([...keys]);
        const rows = await repositoryQueries(db)
          .select({ id: ledgerParty.id, userId: ledgerParty.userId })
          .from(ledgerParty)
          .where(
            inArray(
              ledgerParty.id,
              keys.map((key) => ledgerPartyId.parse(key)),
            ),
          );
        return new Map(rows.map((row) => [row.id, row.userId]));
      },
    };
    const kernel = createKernel([
      defineModule({
        ...fixture.module,
        evidence: [chargeEvidence, privateEvidence],
      }),
    ]);
    await kernel.append(ctx.db, [
      charge("ORD-PRIVATE", 1250),
      ...["a", "b", "c"].map((sourceRef) =>
        evidenceRow(privateEvidence, {
          sourceRef,
          orderRef: "ORD-PRIVATE",
          amountMinor: 1250,
          merchant: "Synthetic Grocer",
          owner: sourceRef === "c" ? unknownOwner : party.id,
        }),
      ),
    ]);
    await settle(kernel);
    const [booked] = await purchases(ctx.db);
    const own = await kernel.machinery(ctx.db, ctx.actor, {
      entity: PURCHASE_TABLE,
      id: booked!.id,
    });
    expect(resolved.map((keys) => keys.sort())).toEqual([
      [party.id, unknownOwner].sort(),
    ]);
    expect(
      own.inputs.items
        .filter((input) => input.kind === "evidence")
        .filter((input) => input.at === null),
    ).toHaveLength(1);
    await repositoryQueries(ctx.db)
      .update(ledgerParty)
      .set({ userId: null })
      .where(eq(ledgerParty.id, party.id));
    expect(
      own.scopes.some(
        (scope) => scope.kind === CATEGORY_SCOPE && scope.key === booked!.id,
      ),
    ).toBe(true);
    const hidden = await kernel.machinery(ctx.db, ctx.actor, {
      entity: PURCHASE_TABLE,
      id: booked!.id,
    });
    expect(resolved).toHaveLength(2);
    expect(
      hidden.inputs.items.filter(
        (input) => input.kind === "evidence" && input.at === null,
      ),
    ).toHaveLength(3);
  });

  it("converges two pieces of evidence to one record in either arrival order", async () => {
    const { kernel } = kernelWith();
    await kernel.append(ctx.db, [charge("ORD-A", 1250)]);
    await settle(kernel);
    await kernel.append(ctx.db, [receipt("ORD-A", "Synthetic Grocer")]);
    await settle(kernel);

    await kernel.append(ctx.db, [receipt("ORD-B", "Synthetic Grocer")]);
    await settle(kernel);
    await kernel.append(ctx.db, [charge("ORD-B", 1250)]);
    await settle(kernel);

    const rows = await purchases(ctx.db);
    expect(
      rows.map(({ orderRef, amountMinor, merchant, category }) => ({
        orderRef,
        amountMinor,
        merchant,
        category,
      })),
    ).toEqual([
      {
        orderRef: "ORD-A",
        amountMinor: 1250,
        merchant: "Synthetic Grocer",
        category: "Groceries",
      },
      {
        orderRef: "ORD-B",
        amountMinor: 1250,
        merchant: "Synthetic Grocer",
        category: "Groceries",
      },
    ]);
    expect(await dirtyCount(ctx.db)).toBe(0);
  });

  it("writes nothing when an input changes during the load, and reruns the scope", async () => {
    let loads = 0;
    let storedDuringRerun: number | null = null;
    const { kernel } = kernelWith({
      onLoad: async (scope) => {
        if (scope !== PURCHASE_SCOPE) return;
        loads += 1;
        if (loads === 1)
          await kernel.append(ctx.db, [
            charge("ORD-C", 900, "stmt-ORD-C-late"),
          ]);
        else storedDuringRerun = (await purchases(ctx.db)).length;
      },
    });
    await kernel.append(ctx.db, [charge("ORD-C", 400, "stmt-ORD-C-early")]);

    const outcomes = await kernel.reconcileNow(ctx.db, [
      { kind: PURCHASE_SCOPE, key: "ORD-C" },
    ]);

    expect(outcomes.map((outcome) => outcome.status)).toEqual(["waiting"]);
    expect(storedDuringRerun).toBe(0);
    const [stored] = await purchases(ctx.db);
    expect(stored?.amountMinor).toBe(900);
  });

  it("publishes a locked fallback with newly created output keys", async () => {
    const { kernel } = kernelWith();
    const scope = { kind: PURCHASE_SCOPE, key: "ORD-LOCKED" };
    await kernel.append(ctx.db, [charge(scope.key, 100)]);
    await repositoryQueries(ctx.db).execute(
      sql`UPDATE "ScopeDirty" SET conflicts=3 WHERE "scopeKind"=${scope.kind}`,
    );
    const claims = await claimScopes(
      repositoryQueries(ctx.db),
      kernel.registry,
      "money",
      1,
      [scope],
    );
    const outcomes = await runClaimedScopes(
      ctx.db,
      kernel.registry,
      kernel.registry.reconcilers.get(scope.kind)!,
      claims,
      { mode: "background", releaseBaseline: false },
    );
    expect(outcomes.map((item) => item.status)).toEqual(["waiting"]);
    expect(await purchases(ctx.db)).toEqual([
      expect.objectContaining({ orderRef: scope.key, amountMinor: 100 }),
    ]);
    expect(
      await repositoryQueries(ctx.db).select().from(fixturePurchase),
    ).toHaveLength(1);
  });

  it("releases a locked-run deadlock without spending an attempt", async () => {
    const reconciler = defineReconciler({
      scope: "fixture.deadlock",
      lane: "money",
      version: 1,
      reads: [],
      writes: [],
      async load() {
        throw Object.assign(new Error("Synthetic deadlock"), { code: "40P01" });
      },
      reconcile(_input, c) {
        return c.done();
      },
    });
    const kernel = createKernel([
      defineModule({ name: "deadlock", reconcilers: [reconciler] }),
    ]);
    const scope = { kind: reconciler.scope, key: "synthetic" };
    await kernel.emitWrites(ctx.db, {
      table: fixturePurchase,
      ids: [],
      columns: [],
      discovers: [scope],
    });
    await repositoryQueries(ctx.db).execute(
      sql`UPDATE "ScopeDirty" SET conflicts=3 WHERE "scopeKind"=${scope.kind}`,
    );
    const claims = await claimScopes(
      repositoryQueries(ctx.db),
      kernel.registry,
      "money",
      1,
      [scope],
    );
    const outcomes = await runClaimedScopes(
      ctx.db,
      kernel.registry,
      reconciler,
      claims,
      { mode: "background", releaseBaseline: false },
    );
    expect(outcomes.map((item) => item.status)).toEqual(["conflict"]);
    expect(
      (
        await repositoryQueries(ctx.db).execute<{
          attempts: number;
          conflicts: number;
          claimToken: string | null;
        }>(
          sql`SELECT attempts,conflicts,"claimToken" FROM "ScopeDirty" WHERE "scopeKind"=${scope.kind}`,
        )
      ).rows,
    ).toEqual([{ attempts: 0, conflicts: 4, claimToken: null }]);
  });

  it.each(["load", "apply"])(
    "isolates a poisoned %s scope without charging healthy siblings",
    async (phase) => {
      const target = writes(fixturePurchase, ["orderRef", "amountMinor"]);
      const reconciler = defineReconciler({
        scope: "fixture.poison",
        lane: "money",
        version: 1,
        reads: [],
        writes: [target],
        async load(_reads, keys) {
          if (phase === "load" && keys.includes("poison"))
            throw new Error("Synthetic malformed evidence");
          return new Map(keys.map((key) => [key, key]));
        },
        reconcile(key, c) {
          c.record(target, "purchase", {
            orderRef: key,
            amountMinor: key === "poison" ? 1e20 : 100,
          });
          return c.done();
        },
      });
      const kernel = createKernel([
        defineModule({ name: "poison", reconcilers: [reconciler] }),
      ]);
      registerOwnedColumns(ownedColumns(kernel.registry));
      const outcomes = await kernel.reconcileNow(
        ctx.db,
        ["healthy-a", "poison", "healthy-b"].map((key) => ({
          kind: reconciler.scope,
          key,
        })),
      );
      expect(outcomes.filter((item) => item.status === "applied")).toHaveLength(
        2,
      );
      expect(await purchases(ctx.db)).toHaveLength(2);
      const dirty = await repositoryQueries(ctx.db).execute<{
        key: string;
        attempts: number;
        errorClass: string;
      }>(
        sql`SELECT d."scopeKey" AS key, d.attempts, s."errorClass" FROM "ScopeDirty" d JOIN "ScopeState" s USING ("scopeKind", "scopeKey") WHERE d."scopeKind"=${reconciler.scope}`,
      );
      expect(dirty.rows).toEqual([
        {
          key: "poison",
          attempts: 1,
          errorClass: phase === "load" ? "failed" : "isolated",
        },
      ]);
    },
  );

  it("returns waiting without sleeping when a member transaction encounters a held claim", async () => {
    const { kernel } = kernelWith();
    const scope = { kind: PURCHASE_SCOPE, key: "ORD-HELD" };
    await kernel.append(ctx.db, [charge(scope.key, 100)]);
    const claims = await claimScopes(
      repositoryQueries(ctx.db),
      kernel.registry,
      "money",
      1,
      [scope],
    );
    expect(claims).toHaveLength(1);
    const started = performance.now();
    const outcomes = await householdWrite(ctx.db, (tx) =>
      kernel.reconcileNow(tx, [scope]),
    );
    expect(outcomes.map((item) => item.status)).toEqual(["waiting"]);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("retains Run requester links for queued and already answered scope inputs", async () => {
    const { kernel } = kernelWith();
    const runId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "maintenance",
      trigger: "manual",
    });
    await kernel.append(ctx.db, [
      charge("ORD-RUN", 100),
      receipt("ORD-RUN", "Synthetic Grocer"),
    ]);
    await settle(kernel);
    const [stored] = await purchases(ctx.db);
    await kernel.reconcileNow(
      ctx.db,
      [{ kind: CATEGORY_SCOPE, key: stored!.id }],
      { runId },
    );
    const work = await kernel.runWork(ctx.db, runId);
    expect(work.asks).toEqual(
      expect.arrayContaining([expect.objectContaining({ state: "answered" })]),
    );
    const receipts = await repositoryQueries(ctx.db).execute<{
      receipt: unknown;
    }>(
      sql`SELECT receipt FROM "AskScope" WHERE "runId"=${runId}::uuid AND "scopeKind"=${"run"}`,
    );
    expect(receipts.rows).toEqual([
      expect.objectContaining({
        receipt: { answer: { inputHash: expect.any(String) } },
      }),
    ]);
  });

  it("cannot leave a scope clean when a key it read with no rows gains a row before its apply", async () => {
    let raced = false;
    const { kernel, fixture } = kernelWith({
      afterLoad: async (scope) => {
        if (scope !== CATEGORY_SCOPE || raced) return;
        raced = true;
        // The hint discovers only its own order's purchase scope; the category
        // scope reaches it through the merchant key it just read empty.
        await kernel.append(ctx.db, [
          receipt("ORD-OTHER", "Synthetic Grocer", { categoryHint: "Pantry" }),
        ]);
      },
    });
    // The answer exists already, so no ask round trip reruns the scope.
    await kernel.withAsk(ctx.db, fixture.categorize, {
      merchant: "Synthetic Grocer",
    });
    await kernel.append(ctx.db, [
      charge("ORD-D", 1250),
      receipt("ORD-D", "Synthetic Grocer"),
    ]);
    await settle(kernel);

    const [stored] = (await purchases(ctx.db)).filter(
      (row) => row.orderRef === "ORD-D",
    );
    expect(raced).toBe(true);
    expect(stored?.category).toBe("Pantry");
    expect(await dirtyCount(ctx.db)).toBe(0);
  });

  it("renews a compute batch together without reviving expired scopes", async () => {
    const { kernel } = kernelWith();
    await kernel.append(ctx.db, [
      charge("ORD-renew-a", 700),
      charge("ORD-renew-b", 900),
    ]);
    const q = repositoryQueries(ctx.db);
    const claimed = await claimScopes(q, kernel.registry, "money", 10);
    expect(claimed).toHaveLength(2);
    await q.execute(
      sql`UPDATE "ScopeDirty" SET "claimDeadline" = now() + interval '1 second'`,
    );
    await q.execute(
      sql`UPDATE "ScopeDirty" SET "claimDeadline" = now() - interval '1 second' WHERE "scopeKey" = ${claimed[0]!.key}`,
    );
    await renewScopeClaims(q, claimed);
    const result = await q.execute<{ key: string; renewed: boolean }>(sql`
      SELECT "scopeKey" AS key, "claimDeadline" > now() + interval '60 seconds' AS renewed FROM "ScopeDirty"`);
    expect(result.rows).toEqual(
      expect.arrayContaining([
        { key: claimed[0]!.key, renewed: false },
        { key: claimed[1]!.key, renewed: true },
      ]),
    );
  });

  it("does not publish through a lapsed claim", async () => {
    const { kernel } = kernelWith();
    await kernel.append(ctx.db, [charge("ORD-E", 700)]);
    const q = repositoryQueries(ctx.db);
    const claimed = await claimScopes(q, kernel.registry, "money", 10);
    const reconciler = kernel.registry.reconcilers.get(PURCHASE_SCOPE)!;
    const computed = await computeBatch(
      q,
      kernel.registry,
      reconciler,
      claimed,
      {
        locked: false,
        hideBaseline: false,
      },
    );
    await q.execute(
      sql`UPDATE "ScopeDirty" SET "claimDeadline" = now() - interval '1 second'`,
    );

    const outcomes = await applyComputed(
      ctx.db,
      kernel.registry,
      reconciler,
      computed,
      claimed,
      {
        releaseBaseline: false,
        mode: "background",
      },
    );

    expect(outcomes.map((outcome) => outcome.status)).toEqual(["failed"]);
    expect(await purchases(ctx.db)).toEqual([]);
    expect(await dirtyCount(ctx.db)).toBe(1);
  });

  it("funding release preserves the cursor of a running pass", async () => {
    const pass = definePass({
      name: "fixture.running-funding",
      async run(db) {
        await releaseFundingWaits(db);
        return { cursor: { page: 1 }, done: false };
      },
    });
    const kernel = createKernel([
      defineModule({ name: "passes", passes: [pass] }),
    ]);
    await kernel.startPass(ctx.db, pass, { cursor: { page: 0 } });
    await runOnePass(ctx.db, kernel.registry);
    const result = await repositoryQueries(ctx.db).execute<{ cursor: unknown }>(
      sql`SELECT cursor FROM "Pass" WHERE name = ${pass.name}`,
    );
    expect(result.rows).toEqual([{ cursor: { page: 1 } }]);
  });

  it("cannot publish a cancelled pass holder's cursor after the pass is restarted", async () => {
    const pass = definePass({
      name: "fixture.restart",
      async run(db, _cursor, claim) {
        await repositoryQueries(db)
          .execute(sql`UPDATE "Pass" SET "cancelledAt" = now()
          WHERE name = ${pass.name}`);
        await kernel.startPass(db, pass, { cursor: { page: 0 } });
        await expect(claim.fence(db)).rejects.toBeInstanceOf(ClaimLapsedError);
        return { cursor: { page: 99 }, done: true };
      },
    });
    const kernel = createKernel([
      defineModule({
        name: "passes",
        passes: [pass],
        machinery: [
          { entity: "run", owning: null, fields: false, quality: false },
        ],
      }),
    ]);
    const runId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "maintenance",
      trigger: "manual",
    });
    await kernel.startPass(ctx.db, pass, {
      key: "background",
      availableAt: new Date(Date.now() - 60_000),
    });
    await kernel.startPass(ctx.db, pass, { runId });
    await runOnePass(ctx.db, kernel.registry);
    const result = await repositoryQueries(ctx.db).execute<{
      cursor: unknown;
      doneAt: string | null;
      claimToken: string | null;
    }>(
      sql`SELECT cursor, "doneAt", "claimToken" FROM "Pass" WHERE name = ${pass.name} AND key = ${"default"}`,
    );
    expect(result.rows).toEqual([
      { cursor: { page: 0 }, doneAt: null, claimToken: null },
    ]);
    const work = await kernel.runWork(ctx.db, runId);
    expect(
      work.passes.filter((entry) => entry.name === pass.name),
    ).toMatchObject([
      { name: pass.name, key: "default", stage: "waiting", lastError: null },
    ]);
    expect(
      (await kernel.machinery(ctx.db, ctx.actor, { entity: "run", id: runId }))
        .passes,
    ).toEqual(work.passes);
    const next = await claimPass(ctx.db, [pass]);
    expect(next).not.toBeNull();
    await expect(
      fenceClaim(
        repositoryQueries(ctx.db),
        { table: "Pass", name: pass.name, key: "default" },
        next!.token,
      ),
    ).resolves.toBeUndefined();
  });

  it("keeps a wake and its newer cursor when a holder publishes an older completion or wait", async () => {
    let page = 0;
    const pass = definePass({
      name: "fixture.wake-race",
      async run(db, cursor) {
        page++;
        await repositoryQueries(db).execute(
          sql`UPDATE "Pass" SET cursor = '{"page":2}'::jsonb WHERE name = ${pass.name}`,
        );
        await kernel.startPass(db, pass);
        return {
          cursor,
          done: page === 1,
          availableAt: new Date(Date.now() + 60_000),
          waitCause: "funding",
        };
      },
    });
    const kernel = createKernel([
      defineModule({ name: "wake-race", passes: [pass] }),
    ]);
    await kernel.startPass(ctx.db, pass, { cursor: { page: 1 } });
    for (let attempt = 0; attempt < 2; attempt++) {
      await runOnePass(ctx.db, kernel.registry);
      const [row] = (
        await repositoryQueries(ctx.db).execute<{
          cursor: unknown;
          done: boolean;
          due: boolean;
          waitCause: string | null;
        }>(
          sql`SELECT cursor, "doneAt" IS NOT NULL AS done, "availableAt" <= now() AS due, "waitCause" FROM "Pass" WHERE name = ${pass.name}`,
        )
      ).rows;
      expect(row).toEqual({
        cursor: { page: 2 },
        done: false,
        due: true,
        waitCause: null,
      });
    }
  });

  it("keeps a retained host's uncertain request unknown until the member settles it", async () => {
    let calls = 0;
    const ask = defineAsk({
      feature: "fixture.retained-host",
      producer: "model",
      promptVersion: "1",
      input: z.string(),
      output: z.string(),
      produce: async () => {
        calls++;
        return { output: "Synthetic answer" };
      },
    });
    const kernel = createKernel([
      defineModule({ name: "retained-host", asks: [ask] }),
    ]);
    const options = { initialOutcome: "unknown" as const };
    await expect(
      kernel.withAsk(ctx.db, ask, "synthetic", options),
    ).rejects.toBeInstanceOf(AskUnknownError);
    expect(calls).toBe(0);
    const [row] = (
      await repositoryQueries(ctx.db).execute<{ inputHash: string }>(
        sql`SELECT "inputHash" FROM "Ask" WHERE feature = ${ask.feature}`,
      )
    ).rows;
    await settleAskOutcome(ctx.db, kernel.registry, row!.inputHash, "not_sent");
    expect(await kernel.withAsk(ctx.db, ask, "synthetic", options)).toBe(
      "Synthetic answer",
    );
    expect(calls).toBe(1);
  });

  it("cancels a Run's Pass and hosted Ask while retaining a shared scope Ask", async () => {
    const runId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "maintenance",
      trigger: "manual",
    });
    const pass = definePass({
      name: "fixture.cancel-owned",
      run: async (_db, cursor) => ({ cursor, done: true }),
    });
    const hosted = defineAsk({
      feature: "fixture.owned",
      producer: "model",
      hosted: true,
      promptVersion: "1",
      input: z.string(),
      output: z.string(),
      produce: async () => {
        throw new WorkDeferredError(
          "Synthetic wait",
          new Date(Date.now() + 60_000),
          "provider_capacity",
        );
      },
    });
    const shared = { ...hosted, feature: "fixture.shared", hosted: false };
    const kernel = createKernel([
      defineModule({
        name: "cancel-owned",
        asks: [hosted, shared],
        passes: [pass],
      }),
    ]);
    await kernel.startPass(ctx.db, pass, { runId });
    for (const ask of [hosted, shared])
      await expect(
        kernel.withAsk(ctx.db, ask, "synthetic", {
          runId,
          pass: { name: pass.name, key: "default" },
        }),
      ).rejects.toBeInstanceOf(WorkDeferredError);
    await cancelRunWork(ctx.db, runId);
    let sends = 0;
    const racing = defineAsk({
      ...hosted,
      feature: "fixture.cancel-admission",
      admit: () => cancelRunWork(ctx.db, runId),
      produce: async () => {
        sends++;
        return { output: "Synthetic answer" };
      },
    });
    await expect(
      kernel.withAsk(ctx.db, racing, "synthetic", {
        runId,
        pass: { name: pass.name, key: "default" },
      }),
    ).rejects.toThrow("claim lapsed before it was sent");
    expect(sends).toBe(0);
    const rows = (
      await repositoryQueries(ctx.db).execute<{
        feature: string;
        cancelled: boolean;
      }>(
        sql`SELECT feature, "cancelledAt" IS NOT NULL AS cancelled FROM "Ask" WHERE feature <> ${racing.feature} ORDER BY feature`,
      )
    ).rows;
    expect(rows).toEqual([
      { feature: hosted.feature, cancelled: true },
      { feature: shared.feature, cancelled: false },
    ]);
    expect(
      (
        await repositoryQueries(ctx.db).execute<{ cancelled: boolean }>(
          sql`SELECT "cancelledAt" IS NOT NULL AS cancelled FROM "Pass" WHERE name = ${pass.name}`,
        )
      ).rows[0]?.cancelled,
    ).toBe(true);
  });

  it("rolls back a Pass publication and its cursor together", async () => {
    const pass = definePass({
      name: "fixture.atomic-pass",
      run: async () => ({
        cursor: { page: 2 },
        done: true,
        publish: async (tx) => {
          await repositoryQueries(tx).execute(
            sql`INSERT INTO "KeyRev" (key, rev) VALUES ('synthetic:atomic-pass', 1)`,
          );
          throw new Error("Synthetic publication failure");
        },
      }),
    });
    const kernel = createKernel([
      defineModule({ name: "atomic-pass", passes: [pass] }),
    ]);
    await kernel.startPass(ctx.db, pass, { cursor: { page: 1 } });
    await runOnePass(ctx.db, kernel.registry);
    const q = repositoryQueries(ctx.db);
    expect(
      (
        await q.execute<{ key: string }>(
          sql`SELECT key FROM "KeyRev" WHERE key = 'synthetic:atomic-pass'`,
        )
      ).rows,
    ).toEqual([]);
    const [row] = (
      await q.execute<{ cursor: unknown; done: boolean; attempts: number }>(
        sql`SELECT cursor, "doneAt" IS NOT NULL AS done, attempts FROM "Pass" WHERE name = ${pass.name}`,
      )
    ).rows;
    expect(row).toEqual({ cursor: { page: 1 }, done: false, attempts: 1 });
  });

  it.each(["admit", "produce"] as const)(
    "does not restore a funding wait when reset races with %s",
    async (phase) => {
      const until = new Date(Date.now() + 3_600_000);
      const refuse = async () => {
        await releaseFundingWaits(ctx.db);
        throw new WorkDeferredError(
          "Synthetic refusal",
          until,
          "ai_funding_window",
        );
      };
      const ask = defineAsk({
        feature: `fixture.funding-${phase}`,
        producer: "model",
        promptVersion: "1",
        input: z.string(),
        output: z.string(),
        ...(phase === "admit" ? { admit: refuse } : {}),
        produce: async () => {
          await refuse();
          return { output: "unreachable" };
        },
      });
      const kernel = createKernel([
        defineModule({ name: "funding", asks: [ask] }),
      ]);
      await expect(
        kernel.withAsk(ctx.db, ask, "synthetic"),
      ).rejects.toBeInstanceOf(WorkDeferredError);
      const [row] = (
        await repositoryQueries(ctx.db).execute<{
          state: string;
          due: boolean;
          waitCause: string | null;
          attempts: number;
        }>(
          sql`SELECT state, "availableAt" <= now() AS due, "waitCause", attempts FROM "Ask" WHERE feature = ${ask.feature}`,
        )
      ).rows;
      expect(row).toEqual({
        state: "queued",
        due: true,
        waitCause: null,
        attempts: 0,
      });
    },
  );

  it("leaves hosted model Asks to their Pass and wakes it when the retained Answer arrives", async () => {
    const ask = defineAsk({
      feature: "fixture.hosted",
      producer: "model",
      hosted: true,
      promptVersion: "1",
      input: z.string(),
      output: z.string(),
    });
    const pass = definePass({
      name: "fixture.hosted",
      run: async (_db, cursor) => ({ cursor, done: true }),
    });
    const kernel = createKernel([
      defineModule({ name: "hosted", asks: [ask], passes: [pass] }),
    ]);
    const q = repositoryQueries(ctx.db);
    const until = new Date(Date.now() + 60 * 60_000);
    await kernel.startPass(ctx.db, pass, { availableAt: until });
    await expect(kernel.withAsk(ctx.db, ask, "synthetic")).rejects.toThrow(
      "must name its waiting Pass",
    );
    const options = { pass: { name: pass.name, key: "default" } };
    await expect(
      kernel.withAsk(
        ctx.db,
        {
          ...ask,
          produce: async () => {
            throw new WorkDeferredError(
              "Synthetic funding",
              until,
              "ai_funding_window",
            );
          },
        },
        "synthetic",
        options,
      ),
    ).rejects.toBeInstanceOf(WorkDeferredError);
    await q.execute(sql`UPDATE "Ask" SET "availableAt" = now()`);
    const [wake] = (
      await q.execute<{ later: boolean }>(
        sql`SELECT ${nextWakeSql()} > now() + interval '50 minutes' AS later`,
      )
    ).rows;
    expect(wake?.later).toBe(true);
    expect(await runQueuedAsks(ctx.db, kernel.registry, 10)).toBe(0);
    await q.execute(
      sql`UPDATE "Pass" SET "waitCause" = ${kernelWaitCause.enum.funding} WHERE name = ${pass.name}`,
    );
    await releaseFundingWaits(ctx.db, new Date(Date.now() + 60_000));
    expect(
      (
        await q.execute<{ due: boolean }>(
          sql`SELECT "availableAt" <= now() AS due FROM "Pass" WHERE name = ${pass.name}`,
        )
      ).rows[0]?.due,
    ).toBe(true);
    expect(
      await kernel.withAsk(
        ctx.db,
        { ...ask, produce: async () => ({ output: "Synthetic answer" }) },
        "synthetic",
        options,
      ),
    ).toBe("Synthetic answer");
    const [owner] = (
      await q.execute<{ due: boolean; version: number }>(
        sql`SELECT "availableAt" <= now() AS due, "wakeVersion" AS version FROM "Pass" WHERE name = ${pass.name}`,
      )
    ).rows;
    expect(owner).toEqual({ due: true, version: 2 });
  });

  it("shares a household claim partition across inline Asks, queued Asks and Passes", async () => {
    const limit = { partition: "synthetic.agent-turn", slots: 2 };
    let calls = 0;
    const ask = defineAsk({
      feature: "fixture.partition",
      produce: async () => {
        calls++;
        return { output: "synthetic answer" };
      },
      producer: "model",
      promptVersion: "1",
      input: z.string(),
      output: z.string(),
      claimLimit: limit,
    });
    const pass = definePass({
      name: "fixture.partition",
      claimLimit: limit,
      run: async (_db, cursor) => ({ cursor, done: true }),
    });
    const kernel = createKernel([
      defineModule({ name: "partition", asks: [ask], passes: [pass] }),
    ]);
    const q = repositoryQueries(ctx.db);
    const rows = await q.execute<{
      id: string;
    }>(sql`INSERT INTO "Ask" ("inputHash", feature, producer, "promptVersion", input)
      SELECT 'synthetic-partition-' || n, ${ask.feature}, ${askProducer.enum.model}, '1', '{}'::jsonb FROM generate_series(1, 8) n RETURNING id`);
    const ids = rows.rows.map((row) => row.id);
    await q.execute(
      sql`INSERT INTO "AskScope" ("askId", "scopeKind", "scopeKey") SELECT id, '$run', 'synthetic' FROM "Ask" WHERE feature = ${ask.feature}`,
    );
    await kernel.startPass(ctx.db, pass);
    const first = await claimAsk(ctx.db, ids[0]!, limit);
    const heldPass = await claimPass(ctx.db, [pass]);
    expect(first).not.toBeNull();
    expect(heldPass).not.toBeNull();
    await expect(kernel.withAsk(ctx.db, ask, "blocked")).rejects.toThrow(
      "partition is full",
    );
    expect(calls).toBe(0);
    const recover = vi.spyOn(backgroundTasks, "wakeAt").mockResolvedValue();
    await q.execute(
      sql`UPDATE "Ask" SET "availableAt" = now() WHERE id = ${ids[1]!}::uuid`,
    );
    expect(await claimAsk(ctx.db, ids[1]!, limit)).toBeNull();
    expect(recover).toHaveBeenCalledWith(expect.any(Date), {
      source: "kernel.claim-recovery",
    });
    const [when] = recover.mock.calls[0]!;
    expect(when.getTime() - Date.now()).toBeGreaterThan(0);
    expect(when.getTime() - Date.now()).toBeLessThanOrEqual(15_000);
    recover.mockRestore();
    expect(await claimAsks(ctx.db, [ask], 8)).toEqual([]);
    const [parked] = (
      await q.execute<{ waitCause: string; attempts: number; future: boolean }>(
        sql`SELECT "waitCause", attempts, "availableAt" > now() AS future FROM "Ask" WHERE id = ${ids[1]!}::uuid`,
      )
    ).rows;
    expect(parked).toEqual({
      waitCause: "provider_capacity",
      attempts: 0,
      future: true,
    });
    await releaseClaim(q, { table: "Ask", id: ids[0]! }, first!.token);
    expect(await kernel.withAsk(ctx.db, ask, "admitted")).toBe(
      "synthetic answer",
    );
    expect(calls).toBe(1);
    await q.execute(
      sql`UPDATE "Ask" SET "availableAt" = now() WHERE feature = ${ask.feature}`,
    );
    const batch = await claimAsks(ctx.db, [ask], 8);
    expect(batch).toHaveLength(1);
    await cancelClaimable(q, {
      table: "Pass",
      name: pass.name,
      key: "default",
    });
    await q.execute(
      sql`UPDATE "Ask" SET "availableAt" = now() WHERE feature = ${ask.feature}`,
    );
    const concurrent = await Promise.all(
      ids.slice(2).map((id) => claimAsk(ctx.db, id, limit)),
    );
    expect(concurrent.filter(Boolean)).toHaveLength(1);
    await q.execute(
      sql`UPDATE "Ask" SET "claimDeadline" = now() - interval '1 second' WHERE id = ${batch[0]!.id}::uuid`,
    );
    await expect(
      fenceClaim(q, { table: "Ask", id: batch[0]!.id }, batch[0]!.token),
    ).rejects.toBeInstanceOf(ClaimLapsedError);
    expect(await claimAsk(ctx.db, batch[0]!.id, limit)).not.toBeNull();
    const live = await q.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM "Ask" WHERE "claimPartition" = ${limit.partition} AND "claimToken" IS NOT NULL AND "claimDeadline" > now()`,
    );
    expect(live.rows[0]?.n).toBe(2);
  });

  it("retains replay requester receipts and withdraws only the cancelled Run's demand", async () => {
    let calls = 0;
    const { kernel, fixture } = kernelWith({
      categorize: async () => {
        calls++;
        return "Groceries";
      },
    });
    const first = await ensureRun(ctx.db, ctx.actor, { purpose: "background" });
    const second = await ensureRun(ctx.db, ctx.actor, {
      purpose: "background",
    });
    let admittedFor: string | null = null;
    await kernel.withAsk(
      ctx.db,
      {
        ...fixture.categorize,
        admit: async (_db, context) => {
          admittedFor = context.runId;
        },
      },
      { merchant: "Synthetic Replay Shop" },
      { runId: first },
    );
    await kernel.withAsk(
      ctx.db,
      fixture.categorize,
      { merchant: "Synthetic Replay Shop" },
      { runId: second },
    );
    const receipts = await repositoryQueries(ctx.db).execute<{
      receipt: { answer: { inputHash: string } };
    }>(
      sql`SELECT receipt FROM "AskScope" WHERE "scopeKind"=${"run"} AND "runId"=${second}::uuid`,
    );
    expect(receipts.rows[0]?.receipt.answer.inputHash).toMatch(
      /^[a-f0-9]{64}$/u,
    );
    expect(admittedFor).toBe(first);
    expect(calls).toBe(1);
    await cancelRunAsks(ctx.db, first);
    const requests = await repositoryQueries(ctx.db).execute<{
      runId: string;
      cancelled: boolean;
    }>(sql`
      SELECT "runId", "cancelledAt" IS NOT NULL AS cancelled FROM "AskScope" WHERE "scopeKind"=${"run"}`);
    expect(requests.rows).toEqual(
      expect.arrayContaining([
        { runId: first, cancelled: true },
        { runId: second, cancelled: false },
      ]),
    );
    await retryRunAsks(ctx.db, first);
    expect((await kernel.runWork(ctx.db, first)).asks).toEqual(
      expect.arrayContaining([expect.objectContaining({ state: "answered" })]),
    );
    expect(calls).toBe(1);
  });

  it("replays a completed response after Answer publication fails without another producer call", async () => {
    let calls = 0;
    const { kernel, fixture } = kernelWith({
      categorize: async () => {
        calls++;
        return "Groceries";
      },
    });
    const q = repositoryQueries(ctx.db);
    await q.execute(
      sql`CREATE FUNCTION synthetic_fail_answer() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic Answer publication failure'; END $$`,
    );
    await q.execute(
      sql`CREATE TRIGGER synthetic_fail_answer BEFORE INSERT ON "Answer" FOR EACH ROW EXECUTE FUNCTION synthetic_fail_answer()`,
    );
    await expect(
      kernel.withAsk(ctx.db, fixture.categorize, {
        merchant: "Synthetic cached result",
      }),
    ).rejects.toThrow("Failed query:");
    expect(calls).toBe(1);
    await q.execute(sql`DROP TRIGGER synthetic_fail_answer ON "Answer"`);
    await q.execute(sql`UPDATE "Ask" SET "availableAt"=now()`);
    expect(
      await kernel.withAsk(ctx.db, fixture.categorize, {
        merchant: "Synthetic cached result",
      }),
    ).toEqual({ category: "Groceries" });
    expect(calls).toBe(1);
  });

  it("rekeys a queued request when its producer's prompt version changes", async () => {
    const { kernel, fixture } = kernelWith();
    const runId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "background",
      execution: false,
    });
    await expect(
      kernel.withAsk(
        ctx.db,
        {
          ...fixture.categorize,
          promptVersion: "synthetic-original",
          admit: async () => {
            throw new WorkDeferredError(
              "Synthetic funding",
              new Date(Date.now() + 60_000),
              "ai_funding_window",
            );
          },
        },
        { merchant: "Synthetic Original Prompt" },
        { runId },
      ),
    ).rejects.toThrow("Synthetic funding");
    await repositoryQueries(ctx.db).execute(
      sql`UPDATE "Ask" SET "availableAt"=now() WHERE feature=${fixture.categorize.feature}`,
    );
    expect(await runQueuedAsks(ctx.db, kernel.registry, 10)).toBe(1);
    expect(await runQueuedAsks(ctx.db, kernel.registry, 10)).toBe(1);
    const answers = await repositoryQueries(ctx.db).execute<{
      promptVersion: string;
    }>(
      sql`SELECT "promptVersion" FROM "Answer" WHERE feature=${fixture.categorize.feature}`,
    );
    expect(answers.rows).toEqual([
      { promptVersion: fixture.categorize.promptVersion },
    ]);
  });

  it("refuses funding before sent without spending an attempt", async () => {
    let calls = 0;
    const { kernel, fixture } = kernelWith({
      categorize: async () => {
        calls++;
        return "Groceries";
      },
    });
    const runId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "background",
      execution: false,
    });
    await expect(
      kernel.withAsk(
        ctx.db,
        {
          ...fixture.categorize,
          admit: async () => {
            throw new WorkDeferredError(
              "Synthetic funding stop",
              new Date(Date.now() + 60_000),
              "ai_funding_window",
            );
          },
        },
        { merchant: "Synthetic Funding Shop" },
        { runId },
      ),
    ).rejects.toThrow("Synthetic funding stop");
    const rows = await repositoryQueries(ctx.db).execute<{
      state: string;
      sentAt: string | null;
      waitCause: string;
      attempts: number;
    }>(
      sql`SELECT state, "sentAt", "waitCause", attempts FROM "Ask" WHERE feature=${fixture.categorize.feature}`,
    );
    expect(rows.rows).toEqual([
      { state: "queued", sentAt: null, waitCause: "funding", attempts: 0 },
    ]);
    await repositoryQueries(ctx.db).execute(
      sql`UPDATE "Ask" SET "availableAt"=now() WHERE feature=${fixture.categorize.feature}`,
    );
    await cancelRunAsks(ctx.db, runId);
    expect(await runQueuedAsks(ctx.db, kernel.registry, 10)).toBe(0);
    expect(calls).toBe(0);
  });

  it("retains the original database failure for a transactional field writer", async () => {
    const { kernel } = kernelWith();
    const q = repositoryQueries(ctx.db);
    await q.execute(
      sql`ALTER TABLE kernel_fixture."FixturePurchase" ADD CONSTRAINT fixture_positive_test CHECK ("amountMinor">0)`,
    );
    try {
      await kernel.append(ctx.db, [charge("ORD-CONSTRAINT", -1)]);
      const outcomes = await kernel.reconcileNow(ctx.db, [
        { kind: PURCHASE_SCOPE, key: "ORD-CONSTRAINT" },
      ]);
      const failed = outcomes.find((outcome) => outcome.status === "failed");
      expect(findPgError(failed?.cause)?.code).toBe("23514");
      expect(failed?.error).toContain("fixture_positive_test");
    } finally {
      await q.execute(
        sql`ALTER TABLE kernel_fixture."FixturePurchase" DROP CONSTRAINT fixture_positive_test`,
      );
    }
  });

  it("never sends an unknown ask again", async () => {
    let calls = 0;
    const { kernel, fixture } = kernelWith({
      categorize: async () => {
        calls += 1;
        // The Worker stalls past its claim: expiry finds the sent ask first.
        await repositoryQueries(ctx.db).execute(
          sql`UPDATE "Ask" SET "claimDeadline" = now() - interval '1 second' WHERE state = ${ASK.sent}`,
        );
        await expireAsks(ctx.db, kernel.registry);
        throw new Error("synthetic provider timeout");
      },
    });
    // A waiting scope makes the ask the background runner's to run.
    const waiting = {
      scopes: [{ kind: CATEGORY_SCOPE, key: "synthetic-waiter" }],
    };
    await expect(
      kernel.withAsk(
        ctx.db,
        fixture.categorize,
        { merchant: "Synthetic Unknown Market" },
        waiting,
      ),
    ).rejects.toThrow("synthetic provider timeout");

    await expect(
      kernel.withAsk(
        ctx.db,
        fixture.categorize,
        { merchant: "Synthetic Unknown Market" },
        waiting,
      ),
    ).rejects.toBeInstanceOf(AskUnknownError);
    expect(await runQueuedAsks(ctx.db, kernel.registry, 10)).toBe(0);
    const [ask] = (
      await repositoryQueries(ctx.db).execute<{ state: string }>(
        sql`SELECT state FROM "Ask"`,
      )
    ).rows;
    expect(ask?.state).toBe("unknown");
    expect(calls).toBe(1);
  });

  it("fences a shared decision first requested by another scope in an earlier round", async () => {
    const shared = "synthetic:shared";
    const trigger = "synthetic:trigger";
    const reconciler = defineReconciler({
      scope: "fixture.sharedDecision",
      lane: "money",
      version: 1,
      reads: [],
      writes: [],
      async load(_reads, keys) {
        return new Map(keys.map((key) => [key, key]));
      },
      reconcile(key, c) {
        if (key === "a" || c.decision("assignment", trigger, "ready"))
          c.decision("assignment", shared, "value");
        return c.done();
      },
    });
    const kernel = createKernel([
      defineModule({ name: "sharedDecision", reconcilers: [reconciler] }),
    ]);
    await kernel.decide(ctx.db, ctx.actor, [
      {
        channel: "assignment",
        subject: trigger,
        field: "ready",
        kind: "set",
        value: true,
      },
    ]);
    const computed = await computeBatch(
      repositoryQueries(ctx.db),
      kernel.registry,
      reconciler,
      [
        { kind: reconciler.scope, key: "a" },
        { kind: reconciler.scope, key: "b" },
      ],
      { locked: false, hideBaseline: false },
    );
    expect(computed.map((item) => [...item.keys.keys()])).toEqual([
      expect.arrayContaining([`decision:${shared}`]),
      expect.arrayContaining([`decision:${shared}`]),
    ]);
  });

  it("reports the final outcome once when a synchronous batch invalidates a sibling scope", async () => {
    const { kernel } = kernelWith();
    await kernel.append(ctx.db, [
      charge("ORD-BATCH-A", 100),
      charge("ORD-BATCH-B", 200),
    ]);
    const outcomes = await kernel.reconcileNow(ctx.db, [
      { kind: PURCHASE_SCOPE, key: "ORD-BATCH-A" },
      { kind: PURCHASE_SCOPE, key: "ORD-BATCH-B" },
    ]);
    expect(outcomes).toHaveLength(2);
    expect(outcomes.map((outcome) => outcome.status)).not.toContain("conflict");
    expect(await purchases(ctx.db)).toHaveLength(2);
  });

  it("refreshes gaps and dependencies when a version sweep leaves records unchanged", async () => {
    const seller = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic rules-only input",
    });
    const scope = { kind: "fixture.ruleMetadata", key: seller.id };
    const module = (version: number) =>
      defineModule({
        name: "ruleMetadata",
        reconcilers: [
          defineReconciler<null>({
            scope: scope.kind,
            lane: "money",
            version,
            reads: [source.table(vendor, ["name"])],
            writes: [],
            async load(reads, keys) {
              if (version > 1) await reads.rows(vendor, keys);
              return new Map(keys.map((key) => [key, null]));
            },
            reconcile(_input, c) {
              if (version > 1) c.gap.decision("a reviewed current rule");
              return c.done();
            },
          }),
        ],
      });
    const first = createKernel([module(1)]);
    await first.emitWrites(ctx.db, {
      table: vendor,
      ids: [seller.id],
      columns: ["name"],
      discovers: [scope],
    });
    await settle(first);
    const next = createKernel([module(2)]);
    await settle(next);
    const state = await repositoryQueries(ctx.db).execute<{
      version: number;
      stage: string;
      firstGap: string;
      key: string;
    }>(sql`
      SELECT s.version, s.stage, s."firstGap", d.key FROM "ScopeState" s JOIN "ScopeDep" d USING ("scopeKind", "scopeKey")
      WHERE s."scopeKind" = ${scope.kind} AND s."scopeKey" = ${scope.key}`);
    expect(state.rows).toContainEqual(
      expect.objectContaining({
        version: 2,
        stage: "needs_you",
        firstGap: "a reviewed current rule",
        key: `row:Vendor:${seller.id}`,
      }),
    );
    const dirty = await repositoryQueries(ctx.db).execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM "ScopeDirty" WHERE "scopeKind"=${scope.kind} AND "scopeKey"=${scope.key}`);
    expect(dirty.rows[0]?.n).toBe(0);
    expect(await repositoryQueries(ctx.db).select().from(drift)).toEqual([]);
  });

  it("turns a version change alone into a Drift proposal, not a record change", async () => {
    const { kernel } = kernelWith();
    await kernel.append(ctx.db, [
      charge("ORD-F", 1250),
      receipt("ORD-F", "Synthetic Grocer"),
    ]);
    await settle(kernel);

    const { kernel: next } = kernelWith({ purchaseVersion: 2 });
    await settle(next);

    const [stored] = await purchases(ctx.db);
    expect(stored?.merchant).toBe("Synthetic Grocer");
    expect(await dirtyCount(ctx.db)).toBe(0);
    const [proposal] = (
      await repositoryQueries(ctx.db).execute<{
        proposalHash: string;
        scopeKey: string;
      }>(sql`SELECT "proposalHash", "scopeKey" FROM "Drift"`)
    ).rows;
    expect(proposal?.scopeKey).toBe("ORD-F");

    await expect(
      next.approveDrift(
        ctx.db,
        ctx.actor,
        { kind: PURCHASE_SCOPE, key: "ORD-F" },
        proposal!.proposalHash,
      ),
    ).resolves.toBe("applied");
    const [approved] = await purchases(ctx.db);
    expect(approved?.merchant).toBe("SYNTHETIC GROCER");
  });

  it("keeps a member's decision through recomputation", async () => {
    let calls = 0;
    const { kernel } = kernelWith({
      categorize: async () => {
        calls++;
        return "Groceries";
      },
    });
    await kernel.append(ctx.db, [
      charge("ORD-G", 1250),
      receipt("ORD-G", "Synthetic Grocer"),
    ]);
    await settle(kernel);
    const [booked] = await purchases(ctx.db);
    const callsBeforeDecision = calls;

    await kernel.decide(ctx.db, ctx.actor, [
      {
        channel: "assignment",
        kind: "set",
        subject: recordSubject(PURCHASE_TABLE, booked!.id),
        field: "merchant",
        value: "Corner Market",
      },
      {
        channel: "assignment",
        kind: "set",
        subject: recordSubject(PURCHASE_TABLE, booked!.id),
        field: "category",
        value: "Household",
      },
    ]);
    await settle(kernel);
    // Only the kernel's apply step writes an owned column.
    const refused = await repositoryQueries(ctx.db)
      .update(fixturePurchase)
      .set({ merchant: "Direct Write" })
      .where(eq(fixturePurchase.id, booked!.id))
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(
      String(refused instanceof Error ? (refused.cause ?? refused) : refused),
    ).toContain("reconciler-owned");
    await kernel.append(ctx.db, [receipt("ORD-G", "Synthetic Grocer Revised")]);
    await settle(kernel);

    const [stored] = await repositoryQueries(ctx.db)
      .select()
      .from(fixturePurchase)
      .where(eq(fixturePurchase.id, booked!.id));
    expect(stored?.merchant).toBe("Corner Market");
    expect(stored?.category).toBe("Household");
    // A decision discovered after the first computation round must suppress its paid ask.
    expect(calls).toBe(callsBeforeDecision);
    const owed = await repositoryQueries(ctx.db).execute<{ id: string }>(
      sql`SELECT id FROM "Ask" WHERE input->${"input"}->>${"merchant"} = ${"Corner Market"}`,
    );
    expect(owed.rows).toEqual([]);

    const [originalReceipt] = await repositoryQueries(ctx.db)
      .select()
      .from(fixtureReceipt)
      .where(eq(fixtureReceipt.sourceRef, "mail-ORD-G-Synthetic Grocer"));
    const rosterRev = async () =>
      (
        await repositoryQueries(ctx.db).execute<{ rev: number }>(
          sql`SELECT coalesce(max(rev), 0)::int AS rev FROM "KeyRev" WHERE key=${`table:${PURCHASE_TABLE}`}`,
        )
      ).rows[0]!.rev;
    const beforeRepoint = await rosterRev();
    const changed = await repositoryTransactionDatabase(ctx.db, (tx) =>
      kernel.repointOwnedReference(tx, {
        table: fixturePurchase,
        column: "receiptId",
        fromIds: [stored!.receiptId!],
        toId: originalReceipt!.id,
      }),
    );
    const seller = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic repoint seller",
    });
    const parent = await createPurchaseEventRecord(ctx.db, "purchase", {
      vendorId: seller.id,
    });
    const child = await createPurchaseEventRecord(ctx.db, "expense", {
      name: "Synthetic repoint line",
      costType: "materials",
      purchaseId: parent.id,
    });
    const detached = await repositoryTransactionDatabase(ctx.db, async (tx) => {
      const count = await repointOwnedReference(tx, {
        table: expense,
        column: "purchaseId",
        fromIds: [parent.id],
        toId: null,
        liveOnly: true,
      });
      const probe = await repositoryTransactionDatabase(ctx.db, (other) =>
        repositoryQueries(other).execute<{ acquired: boolean }>(
          sql`SELECT pg_try_advisory_xact_lock(hashtextextended('cubby:household-write', 0)) AS acquired`,
        ),
      );
      expect(probe.rows[0]?.acquired).toBe(false);
      return count;
    });
    expect(detached).toBe(1);
    expect(
      (
        await repositoryQueries(ctx.db)
          .select()
          .from(expense)
          .where(eq(expense.id, child.id))
      )[0]?.purchaseId,
    ).toBeNull();
    expect(changed).toBe(1);
    expect(await rosterRev()).toBe(beforeRepoint + 1);
    expect(
      await repositoryTransactionDatabase(ctx.db, (tx) =>
        kernel.repointOwnedReference(tx, {
          table: fixturePurchase,
          column: "receiptId",
          fromIds: [originalReceipt!.id],
          toId: stored!.receiptId!,
          where: eq(fixturePurchase.id, crypto.randomUUID()),
        }),
      ),
    ).toBe(0);
    expect(await rosterRev()).toBe(beforeRepoint + 1);
    const [repointed] = await purchases(ctx.db);
    expect(repointed?.receiptId).toBe(originalReceipt!.id);
    await expect(
      repositoryTransactionDatabase(ctx.db, (tx) =>
        kernel.repointOwnedReference(tx, {
          table: fixturePurchase,
          column: "merchant",
          fromIds: ["Corner Market"],
          toId: null,
        }),
      ),
    ).rejects.toThrow("not a reconciler-owned foreign key");
  });

  it("hands a merged record to the survivor's scope and ends the absorbed scope", async () => {
    const { kernel, fixture } = kernelWith();
    await kernel.append(ctx.db, [charge("ORD-M1", 100)]);
    await settle(kernel);
    await kernel.append(ctx.db, [charge("ORD-M2", 200)]);
    await settle(kernel);
    const [older, newer] = await purchases(ctx.db);

    const verdict = await kernel.merge(ctx.db, {
      target: fixture.purchaseWrites,
      a: newer!.id,
      b: older!.id,
      basis: "decision",
      actor: ctx.actor,
    });
    expect(verdict).toMatchObject({
      merged: true,
      keepId: older!.id,
      loserId: newer!.id,
    });
    await settle(kernel);
    // Evidence that still reaches the absorbed scope reruns the survivor; the
    // absorbed scope writes nothing again.
    await kernel.append(ctx.db, [charge("ORD-M2", 300, "stmt-ORD-M2-late")]);
    await settle(kernel);

    const live = (await purchases(ctx.db)).filter(
      (row) => row.deletedAt === null,
    );
    expect(
      live.map(({ id, orderRef, amountMinor }) => ({
        id,
        orderRef,
        amountMinor,
      })),
    ).toEqual([{ id: older!.id, orderRef: "ORD-M1", amountMinor: 200 }]);
    const states = await repositoryQueries(ctx.db).execute<{
      key: string;
      stage: string;
      into: string | null;
    }>(
      sql`SELECT "scopeKey" AS key, stage, "mergedIntoKey" AS into FROM "ScopeState"
        WHERE "scopeKind" = ${PURCHASE_SCOPE} ORDER BY "scopeKey"`,
    );
    expect(states.rows).toEqual([
      { key: "ORD-M1", stage: "waiting", into: null },
      { key: "ORD-M2", stage: "ended", into: "ORD-M1" },
    ]);
    const bindings = await repositoryQueries(ctx.db).execute<{
      eventKey: string;
    }>(sql`SELECT DISTINCT "eventKey" FROM "EvidenceBinding"`);
    expect(bindings.rows).toEqual([{ eventKey: "ORD-M1" }]);
  });

  it("keeps a veto in force after a later assignment is released", async () => {
    const { kernel } = kernelWith();
    await kernel.append(ctx.db, [
      charge("ORD-H", 1250),
      receipt("ORD-H", "Synthetic Grocer"),
    ]);
    await settle(kernel);
    const [booked] = await purchases(ctx.db);
    const subject = recordSubject(PURCHASE_TABLE, booked!.id);

    await kernel.decide(ctx.db, ctx.actor, [
      {
        channel: "veto",
        kind: "veto",
        subject,
        field: "category",
        value: "Groceries",
      },
      {
        channel: "assignment",
        kind: "set",
        subject,
        field: "category",
        value: "Dining",
      },
      { channel: "assignment", kind: "release", subject, field: "category" },
    ]);
    await settle(kernel);

    const [stored] = await purchases(ctx.db);
    expect(stored?.category).toBeNull();
  });
});
