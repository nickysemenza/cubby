import { ledgerPartyId } from "@cubby/schemas/identifiers";
import { askProducer } from "@cubby/schemas/kernel/machinery";
import { eq, inArray, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { beforeEach, describe, expect, it } from "vitest";
/**
 * The kernel's dangerous rules (ADR 0029): order-independent convergence,
 * the `seq` and `rev` fences, claim expiry, never resending an unknown ask,
 * history protection, and decisions that outlive recomputation.
 */
import { z } from "zod";

import type { Database } from "~/server/db/database";
import { entityIdentity } from "~/server/db/entity-identity-schema";
import {
  repositoryQueries,
  repositoryTransactionDatabase,
} from "~/server/db/repository-access.boundary";
import { ledgerParty, transactionImport } from "~/server/db/schema";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import { ensureExternalSources } from "~/server/generic/entity-links/repo/entity-external-ids";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

import {
  createKernel,
  defineModule,
  defineAsk,
  defineEvidence,
  definePass,
  evidenceRow,
  recordSubject,
  type Kernel,
} from "./api";
import { applyComputed } from "./apply";
import { AskUnknownError, expireAsks, runQueuedAsks } from "./ask";
import {
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

  it("shares a household claim partition across inline Asks, queued Asks and Passes", async () => {
    const limit = { partition: "synthetic.agent-turn", slots: 2 };
    const ask = defineAsk({
      feature: "fixture.partition",
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
    expect(await claimAsk(ctx.db, ids[1]!, limit)).toBeNull();
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
