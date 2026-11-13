/**
 * The kernel's dangerous rules (ADR 0029): order-independent convergence,
 * the `seq` and `rev` fences, claim expiry, never resending an unknown ask,
 * history protection, and decisions that outlive recomputation.
 */
import { eq, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { beforeEach, describe, expect, it } from "vitest";

import type { Database } from "~/server/db/database";
import {
  repositoryQueries,
  repositoryTransactionDatabase,
} from "~/server/db/repository-access.boundary";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";

import {
  createKernel,
  defineModule,
  definePass,
  evidenceRow,
  recordSubject,
  type Kernel,
} from "./api";
import { applyComputed } from "./apply";
import { AskUnknownError, expireAsks, runQueuedAsks } from "./ask";
import { claimPass, ClaimLapsedError, claimScopes, fenceClaim } from "./claim";
import { computeBatch } from "./compute";
import { runOnePass } from "./pass";
import {
  CATEGORY_SCOPE,
  chargeEvidence,
  fixtureModule,
  fixturePurchase,
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
    return { kernel: createKernel([fixture.module]), fixture };
  };
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

    expect(outcomes.map((outcome) => outcome.status)).toEqual([
      "conflict",
      "waiting",
    ]);
    expect(storedDuringRerun).toBe(0);
    const [stored] = await purchases(ctx.db);
    expect(stored?.amountMinor).toBe(900);
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
    expect(work.passes).toMatchObject([
      { name: pass.name, key: "default", stage: "waiting", lastError: null },
    ]);
    expect(
      (await kernel.machinery(ctx.db, ctx.actor, { entity: "run", id: runId }))
        .passes,
    ).toEqual(work.passes);
    const next = await claimPass(repositoryQueries(ctx.db), [pass.name]);
    expect(next).not.toBeNull();
    await expect(
      fenceClaim(
        repositoryQueries(ctx.db),
        { table: "Pass", name: pass.name, key: "default" },
        next!.token,
      ),
    ).resolves.toBeUndefined();
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
    const changed = await repositoryTransactionDatabase(ctx.db, (tx) =>
      kernel.repointOwnedReference(tx, {
        table: fixturePurchase,
        column: "receiptId",
        fromIds: [stored!.receiptId!],
        toId: originalReceipt!.id,
      }),
    );
    expect(changed).toBe(1);
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
