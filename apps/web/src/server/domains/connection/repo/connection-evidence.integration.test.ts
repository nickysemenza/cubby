import { ASSESSMENT_READ_TARGET } from "@cubby/schemas/assessment-read-publication";
import {
  type ConnectionCandidate,
  connectionCandidate,
} from "@cubby/schemas/entity-connections";
import { eq, sql } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { getDb, withTransactionDatabase } from "~/server/db/helpers";
import { householdDaySql } from "~/server/db/helpers/query";
import {
  entityLink,
  expense as expenseTable,
  financialTransactionAllocation,
  financialTransaction,
  product as productTable,
  project as projectTable,
  assessmentReadPublication,
  assessmentReadStage,
} from "~/server/db/schema";
import { prepareEntityConnectionSources } from "~/server/domains/connection/service/entity-connections";
import { deletePurchases } from "~/server/domains/purchase/repo/purchase";
import { findOrCreateVendor } from "~/server/domains/vendor/repo/vendor";
import {
  assessmentReadSourceSelection,
  writeAssessmentReadStage,
} from "~/server/generic/assessment/repo/read-publication";
import { prepareSuggestionAdmission } from "~/server/generic/assessment/repo/suggestion-list";
import { prepareCanonicalAssessmentReadPublication } from "~/server/generic/assessment/service/read-publication";
import { isDerivedSink } from "~/server/generic/derived/repo/compute";
import { readWorkItems } from "~/server/generic/jobs/jobs.fixtures";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import { canonicalJson } from "~/server/lib/canonical-json";
import { measureDatabaseTransfer } from "~/server/testing/database-transfer.fixtures";
import {
  createProductFixture,
  makeProductInput,
} from "~/server/testing/repo.fixtures";
import { derivedComputes } from "~/server/workflows/derived-computes";

import {
  captureConnectionBasis,
  forEachConnectionBasis,
  prepareConnectionBases,
} from "./connection-evidence";
import { connectionDiscoveryFingerprint } from "./discovery-fingerprint";
import {
  prepareEntityConnectionEvidence,
  publishPreparedEntityConnections,
  readEntityConnections,
  publishEntityConnection,
} from "./entity-connections";

// Freshness checks capture many bases from prepared, batched reads. Each must
// equal the basis the same candidate captures alone, and an endpoint that no
// longer resolves must still fail the capture.
describe("prepared connection bases", () => {
  const ctx = withTestDb();

  it("capture exactly the per-candidate basis", async () => {
    const vendor = await createRepoEntity(ctx, "vendor", {
      name: "Synthetic basis supplier",
    });
    const account = await createRepoEntity(ctx, "financialAccount", {
      name: "Synthetic basis card",
      identity: { kind: "cash" },
    });
    const [order, gone] = await Promise.all([
      createRepoEntity(ctx, "purchase", {
        vendorId: vendor.output.id,
        date: "2026-09-10",
        statedTotal: 40,
      }),
      createRepoEntity(ctx, "purchase", {
        vendorId: vendor.output.id,
        date: "2026-09-11",
      }),
    ]);
    const [charge, refund] = await Promise.all([
      createRepoEntity(ctx, "financialTransaction", {
        accountId: account.output.id,
        amount: 40,
        kind: "purchase",
        status: "posted",
        postedDate: "2026-09-12",
        merchant: "Synthetic basis supplier",
      }),
      createRepoEntity(ctx, "financialTransaction", {
        accountId: account.output.id,
        amount: -5,
        kind: "refund",
        status: "posted",
        postedDate: "2026-09-14",
      }),
    ]);
    const transferAccount = await createRepoEntity(ctx, "financialAccount", {
      name: "Synthetic basis reserve",
      identity: { kind: "cash" },
    });
    const transferOut = await createRepoEntity(ctx, "financialTransaction", {
      accountId: account.output.id,
      amount: 73,
      kind: "account_transfer",
      status: "posted",
      postedDate: "2026-09-12",
    });
    const transferIn = await createRepoEntity(ctx, "financialTransaction", {
      accountId: transferAccount.output.id,
      amount: -73,
      kind: "account_transfer",
      status: "posted",
      postedDate: "2026-09-13",
    });
    const project = await createRepoEntity(ctx, "project", {
      name: "Synthetic basis project",
    });
    const product = await insertWithShortcode(ctx.db, "product", {
      name: "Synthetic basis drill",
      brandId: await findOrCreateVendor(ctx.db, "Synthetic maker"),
    });
    const line = await createRepoEntity(ctx, "expense", {
      name: "Synthetic basis line",
      date: "2026-09-10",
      trade: "electrical",
      costType: "materials",
      cost: 40,
      purchaseId: order.output.id,
    });
    const history = await createRepoEntity(ctx, "expense", {
      name: "Synthetic contributing project history",
      date: "2026-09-10",
      trade: "electrical",
      costType: "materials",
      cost: 10,
      projectId: project.output.id,
    });
    // Payload rows each relation reads: an allocation of the charge, and a
    // linked line of the Product on the order.
    await getDb(ctx.db).insert(financialTransactionAllocation).values({
      transactionId: charge.entityId,
      purchaseId: order.entityId,
      amount: 25,
    });
    await getDb(ctx.db)
      .insert(entityLink)
      .values({
        kind: "purchaseProduct",
        fromEntityId: order.entityId,
        fromKind: "purchase",
        toEntityId: product.id,
        toKind: "product",
      } as typeof entityLink.$inferInsert);
    await createRepoEntity(ctx, "expense", {
      name: "Synthetic basis drill line",
      date: "2026-09-10",
      trade: "electrical",
      costType: "tools",
      cost: 15,
      productId: product.shortcode,
      purchaseId: order.output.id,
    });
    const evidence = { reasons: [], contradictions: [], unknowns: [] };
    const candidate = (
      relation: ConnectionCandidate["relation"],
      source: { entityKind: string; entityId: string },
      target: { entityKind: string; entityId: string },
    ): ConnectionCandidate =>
      connectionCandidate.parse({
        relation,
        source,
        target,
        label: "Synthetic candidate",
        evidence,
      });
    const ref = (entityKind: string, entityId: string) => ({
      entityKind,
      entityId,
    });
    const candidates = [
      candidate(
        "expense-project",
        ref("expense", line.output.id),
        ref("project", project.output.id),
      ),
      candidate(
        "transaction-purchase",
        ref("financialTransaction", charge.output.id),
        ref("purchase", order.output.id),
      ),
      candidate(
        "transaction-refund",
        ref("financialTransaction", refund.output.id),
        ref("purchase", order.output.id),
      ),
      candidate(
        "transaction-transfer",
        ref("financialTransaction", transferOut.output.id),
        ref("financialTransaction", transferIn.output.id),
      ),
      candidate(
        "project-tool",
        ref("project", project.output.id),
        ref("product", product.shortcode),
      ),
      candidate(
        "product-purchase",
        ref("product", product.shortcode),
        ref("purchase", order.output.id),
      ),
    ];
    const missing = candidate(
      "transaction-purchase",
      ref("financialTransaction", charge.output.id),
      ref("purchase", gone.output.id),
    );
    await deletePurchases(ctx.db, [gone.output.id], ctx.actor);
    const prepared = await prepareConnectionBases(ctx.db, [
      ...candidates,
      missing,
    ]).catch((error: unknown) => error);
    // A missing Purchase fails the whole batch exactly as it fails alone.
    await expect(captureConnectionBasis(ctx.db, missing)).rejects.toThrow(
      "Purchase not found",
    );
    expect(prepared).toBeInstanceOf(Error);
    const ready = await prepareConnectionBases(ctx.db, candidates);
    for (const raw of candidates)
      expect(
        canonicalJson(await captureConnectionBasis(ctx.db, raw, false, ready)),
      ).toBe(canonicalJson(await captureConnectionBasis(ctx.db, raw)));
    const settlement = candidates.find(
      (row) => row.relation === "transaction-purchase",
    );
    if (!settlement) throw new Error("Synthetic settlement candidate missing");
    const proposal = await publishEntityConnection(ctx.db, settlement);
    const late = await createRepoEntity(ctx, "financialTransaction", {
      accountId: account.output.id,
      amount: 40,
      kind: "purchase",
      status: "posted",
      postedDate: "2026-09-12",
      merchant: "Synthetic later candidate",
    });
    const oldId = proposal.review.assessmentId;
    const affected = await getDb(ctx.db).execute(
      assessmentReadSourceSelection(
        "financialTransaction",
        sql`SELECT ${late.entityId}::uuid AS id`,
      ),
    );
    expect(affected.rows.map((row) => row.id)).toContain(oldId);
    const stale = await prepareSuggestionAdmission(ctx.db, [oldId]);
    expect(stale.keys).toEqual([]);
    expect(stale.dependencies.get(oldId)).toEqual(
      expect.arrayContaining([
        { sourceKind: "financialTransaction", sourceId: late.entityId },
      ]),
    );
    const adapter = derivedComputes[ASSESSMENT_READ_TARGET];
    if (!adapter || !isDerivedSink(adapter))
      throw new Error("Synthetic Assessment producer missing");
    const preparedStale = await adapter.prepare(ctx.db, [oldId]);
    expect(adapter.preparationFailures?.(preparedStale).size).toBe(0);
    const tickets = new Map(
      (await readWorkItems(ctx.db, { target: ASSESSMENT_READ_TARGET })).map(
        (row) => [row.ref, row.ticket],
      ),
    );
    const publishedStale = await withTransactionDatabase(ctx.db, (tx) =>
      adapter.publish(tx, [oldId], preparedStale, {
        tickets,
        notify: () => {},
      }),
    );
    expect(publishedStale).toMatchObject({ retain: [], changed: [oldId] });
    // It leaves the current date window, but its observed dependency survives
    // the empty publication and must still refresh advice it can revive.
    await getDb(ctx.db)
      .update(financialTransaction)
      .set({ postedDate: "2027-09-12" })
      .where(eq(financialTransaction.id, late.entityId));
    const moved = await getDb(ctx.db).execute(
      assessmentReadSourceSelection(
        "financialTransaction",
        sql`SELECT ${late.entityId}::uuid AS id`,
      ),
    );
    expect(moved.rows.map((row) => row.id)).toContain(oldId);
    const recordedTransfer = candidates.find(
      (row) => row.relation === "transaction-transfer",
    );
    if (!recordedTransfer)
      throw new Error("Synthetic recorded-transfer candidate missing");
    const transferProposal = await publishEntityConnection(
      ctx.db,
      recordedTransfer,
    );
    const transferPeer = await createRepoEntity(ctx, "financialTransaction", {
      accountId: transferAccount.output.id,
      amount: -73,
      kind: "account_transfer",
      status: "posted",
      postedDate: "2026-09-14",
    });
    const peers = await getDb(ctx.db).execute(
      assessmentReadSourceSelection(
        "financialTransaction",
        sql`SELECT ${transferPeer.entityId}::uuid AS id`,
      ),
    );
    expect(peers.rows.map((row) => row.id)).toContain(
      transferProposal.review.assessmentId,
    );
    const staleTransfer = await prepareSuggestionAdmission(ctx.db, [
      transferProposal.review.assessmentId,
    ]);
    expect(staleTransfer.keys).toEqual([]);
    expect(
      staleTransfer.dependencies.get(transferProposal.review.assessmentId),
    ).toEqual(
      expect.arrayContaining([
        { sourceKind: "financialTransaction", sourceId: transferPeer.entityId },
        { sourceKind: "financialAccount", sourceId: transferAccount.entityId },
      ]),
    );
    const expenseProject = candidates.find(
      (row) => row.relation === "expense-project",
    );
    if (!expenseProject)
      throw new Error("Synthetic expense-project candidate missing");
    const expenseProposal = await publishEntityConnection(
      ctx.db,
      expenseProject,
    );
    const expenseAdmission = await prepareSuggestionAdmission(ctx.db, [
      expenseProposal.review.assessmentId,
    ]);
    expect(
      expenseAdmission.dependencies.get(expenseProposal.review.assessmentId),
    ).toEqual(
      expect.arrayContaining([
        { sourceKind: "expense", sourceId: history.entityId },
        { sourceKind: "project", sourceId: project.entityId },
        { sourceKind: "purchase", sourceId: order.entityId },
      ]),
    );
    const toolCandidate = candidates.find(
      (row) => row.relation === "project-tool",
    );
    if (!toolCandidate || !adapter.clockExpiredRefs)
      throw new Error("Synthetic clock-sensitive sink missing");
    const toolProposal = await publishEntityConnection(ctx.db, toolCandidate);
    const toolId = toolProposal.review.assessmentId;
    const productInputs = await getDb(ctx.db).execute(
      assessmentReadSourceSelection(
        "product",
        sql`SELECT ${product.id}::uuid AS id`,
      ),
    );
    expect(productInputs.rows.map((row) => row.id)).toContain(toolId);
    expect(productInputs.rows.map((row) => row.id)).not.toContain(
      expenseProposal.review.assessmentId,
    );
    await getDb(ctx.db)
      .update(productTable)
      .set({ name: "Synthetic changed clock tool" })
      .where(eq(productTable.id, product.id));
    const prepareClock = async () => {
      const prepared = await prepareCanonicalAssessmentReadPublication(
        ctx.db,
        [toolId],
        async () => () => sql`true`,
      );
      expect([...prepared.failures]).toEqual([]);
      const component = prepared.components.at(0)?.prepared;
      if (!component) throw new Error("Synthetic clock component missing");
      return component;
    };
    const clock = await prepareClock();
    expect(clock.results[0]?.facts).toEqual([]);
    await withTransactionDatabase(ctx.db, (tx) =>
      writeAssessmentReadStage(tx, clock, { notify: () => {} }),
    );
    const clockHeader = async () => {
      const [header] = await getDb(ctx.db)
        .select()
        .from(assessmentReadPublication)
        .where(
          sql`${assessmentReadPublication.assessmentId} = ${toolId}::uuid AND ${assessmentReadPublication.active}`,
        );
      if (!header) throw new Error("Synthetic clock publication missing");
      return header;
    };
    const beforeClock = await clockHeader();
    expect(beforeClock.family).toBeNull();
    const day = householdDaySql(sql`clock_timestamp() AT TIME ZONE 'UTC'`);
    await getDb(ctx.db)
      .update(assessmentReadPublication)
      .set({ clockDay: sql`${day} - 1` })
      .where(eq(assessmentReadPublication.assessmentId, toolId));
    await getDb(ctx.db)
      .update(assessmentReadStage)
      .set({ clockDay: sql`${day} - 1` })
      .where(eq(assessmentReadStage.componentKey, clock.stage.componentKey));
    const expired = await getDb(ctx.db).execute(adapter.clockExpiredRefs(day));
    expect(expired.rows.map((row) => row.id)).toContain(toolId);
    const retryClock = await prepareClock();
    const expiredHeader = await clockHeader();
    expect(
      await withTransactionDatabase(ctx.db, (tx) =>
        writeAssessmentReadStage(
          tx,
          {
            ...retryClock,
            stage: { ...retryClock.stage, clockDay: expiredHeader.clockDay },
          },
          { notify: () => {} },
        ),
      ),
    ).toMatchObject({ kind: "retained" });
    expect(
      await withTransactionDatabase(ctx.db, (tx) =>
        writeAssessmentReadStage(tx, retryClock, { notify: () => {} }),
      ),
    ).toMatchObject({ kind: "activated", changed: [] });
    expect(await clockHeader()).toMatchObject({
      revision: beforeClock.revision,
      computedAt: beforeClock.computedAt,
      clockDay: retryClock.stage.clockDay,
    });
    // One source's proposals can span capture batches and interleave with another's.
    // Sources share included history rows but keep their own exclusions.
    const sharedProduct = await insertWithShortcode(ctx.db, "product", {
      name: "Synthetic shared history fitting",
      brandId: await findOrCreateVendor(ctx.db, "Synthetic maker"),
    });
    const sharedHistory = await createRepoEntity(ctx, "expense", {
      name: 'Synthetic "shared" café 🔧',
      date: "2026-09-10",
      trade: "electrical",
      costType: "materials",
      cost: 10,
      productId: sharedProduct.shortcode,
      projectId: project.output.id,
    });
    const productOnlyHistory = await createRepoEntity(ctx, "expense", {
      name: "Synthetic product-only history",
      date: "2026-09-10",
      trade: "plumbing",
      costType: "materials",
      cost: 10,
      productId: sharedProduct.shortcode,
      projectId: project.output.id,
    });
    // Matches the shared row by both trade and Product.
    const overlapSource = await createRepoEntity(ctx, "expense", {
      name: "Synthetic overlap source",
      date: "2026-09-10",
      trade: "electrical",
      costType: "materials",
      cost: 10,
      productId: sharedProduct.shortcode,
    });
    const interleavedSources = [line, history, overlapSource];
    const interleaved = Array.from({ length: 34 }, (_, index) =>
      candidate(
        "expense-project",
        ref(
          "expense",
          interleavedSources[index % interleavedSources.length]!.output.id,
        ),
        ref("project", project.output.id),
      ),
    );
    const visited: { entry: ConnectionCandidate; batched: unknown }[] = [];
    await forEachConnectionBasis(
      ctx.db,
      interleaved.map((entry) => ({ candidate: entry })),
      async ({ candidate: entry }, batched) => {
        visited.push({ entry, batched });
        // Unsorted bytes: a shared-row basis also keeps the generic key order.
        expect(JSON.stringify(batched)).toBe(
          JSON.stringify(await captureConnectionBasis(ctx.db, entry)),
        );
      },
    );
    expect(visited.map(({ entry }) => entry)).toEqual(interleaved);
    // A skipped visit still counts toward its source's last visit: the one frozen
    // snapshot survives to a real visit in a later capture batch.
    const retained = new Map<string, unknown>();
    const capturedIndexes: number[] = [];
    await forEachConnectionBasis(
      ctx.db,
      interleaved.map((entry, index) => ({ candidate: entry, index })),
      async ({ candidate: entry, index }, batched) => {
        capturedIndexes.push(index);
        expect(JSON.stringify(batched)).toBe(
          JSON.stringify(await captureConnectionBasis(ctx.db, entry)),
        );
        const { dependencies } = z
          .object({ dependencies: z.unknown() })
          .parse(batched);
        expect(dependencies).toBe(
          retained.get(entry.source.entityId) ?? dependencies,
        );
        retained.set(entry.source.entityId, dependencies);
      },
      undefined,
      ({ index }) => index % 2 === 0,
    );
    expect(capturedIndexes).toEqual(
      interleaved.flatMap((_, index) => (index % 2 === 0 ? [] : [index])),
    );
    await withTransactionDatabase(ctx.db, async (tx) => {
      const locked = await prepareConnectionBases(
        tx,
        interleaved,
        undefined,
        true,
      );
      for (const { entry, batched } of visited)
        expect(
          JSON.stringify(await captureConnectionBasis(tx, entry, true, locked)),
        ).toBe(JSON.stringify(batched));
    });
    const historyEvidence = z.object({
      dependencies: z.object({
        history: z.array(z.unknown()),
      }),
    });
    const historyRow = z.object({ id: z.string() });
    const includedRows = (sourceId: string) =>
      historyEvidence.parse(
        visited.find(({ entry }) => entry.source.entityId === sourceId)
          ?.batched,
      ).dependencies.history;
    const includedIds = (sourceId: string) =>
      includedRows(sourceId)
        .map((row) => historyRow.parse(row).id)
        .sort();
    const sortedIds = (...rows: (typeof line)[]) =>
      rows.map((row) => row.output.id).sort();
    expect(includedIds(line.output.id)).toEqual(
      sortedIds(history, sharedHistory),
    );
    expect(includedIds(history.output.id)).toEqual(sortedIds(sharedHistory));
    expect(includedIds(overlapSource.output.id)).toEqual(
      sortedIds(history, sharedHistory, productOnlyHistory),
    );
    const sharedEvidence = (sourceId: string) =>
      includedRows(sourceId).find(
        (row) => historyRow.parse(row).id === sharedHistory.output.id,
      );
    expect(sharedEvidence(overlapSource.output.id)).toBe(
      sharedEvidence(line.output.id),
    );
    expect(Object.isFrozen(sharedEvidence(line.output.id))).toBe(true);
    const [captured] = await prepareEntityConnectionEvidence(
      ctx.db,
      candidates.filter((entry) => entry.relation === "expense-project"),
    );
    const basis = captured?.basis;
    if (!basis || typeof basis !== "object" || Array.isArray(basis))
      throw new Error("Synthetic captured basis missing");
    const source = basis.source;
    if (!source || typeof source !== "object" || Array.isArray(source))
      throw new Error("Synthetic source snapshot missing");
    const before = canonicalJson(basis);
    expect(Reflect.set(source, "name", "Synthetic snapshot tamper")).toBe(
      false,
    );
    expect(canonicalJson(basis)).toBe(before);
    const sourceRef = {
      entityKind: "expense" as const,
      entityId: line.output.id,
    };
    const sourceFingerprint = await connectionDiscoveryFingerprint(
      ctx.db,
      sourceRef,
    );
    const sourceCapture = (
      await prepareEntityConnectionSources(ctx.db, [sourceRef])
    ).get(line.output.id);
    expect(sourceCapture?.status).toBe("fulfilled");
    if (sourceCapture?.status !== "fulfilled")
      throw new Error("Synthetic source capture failed");
    const capturedProjects = sourceCapture.value.filter(
      (entry) => entry.candidate.relation === "expense-project",
    );
    expect(capturedProjects.length).toBeGreaterThan(0);
    await getDb(ctx.db)
      .update(expenseTable)
      .set({ date: "2026-10-10" })
      .where(eq(expenseTable.id, history.entityId));
    expect(await connectionDiscoveryFingerprint(ctx.db, sourceRef)).toBe(
      sourceFingerprint,
    );
    // The shared capture cannot authorize changed history or ancestor windows.
    await expect(
      publishPreparedEntityConnections(ctx.db, capturedProjects),
    ).rejects.toThrow("Connection evidence changed after candidate retrieval");
    expect(await readEntityConnections(ctx.db, sourceRef)).toEqual([]);
    await getDb(ctx.db)
      .update(projectTable)
      .set({ name: "Synthetic current Project evidence" })
      .where(eq(projectTable.id, project.entityId));
    await withTransactionDatabase(ctx.db, async (tx) => {
      // An unlocked shared snapshot cannot satisfy the later locked capture.
      expect(
        canonicalJson(
          await captureConnectionBasis(tx, candidates[0]!, true, ready),
        ),
      ).not.toBe(before);
      const locked = await prepareConnectionBases(
        tx,
        candidates,
        undefined,
        true,
      );
      for (const raw of candidates)
        expect(
          canonicalJson(await captureConnectionBasis(tx, raw, true, locked)),
        ).toBe(canonicalJson(await captureConnectionBasis(tx, raw, true)));
    });
    // Tags are not connection evidence; a large unrelated value must never
    // cross the wire in either the single-record or prepared-batch path.
    await getDb(ctx.db)
      .update(productTable)
      .set({ tags: ["x".repeat(128 * 1024)] })
      .where(eq(productTable.id, product.id));
    const measured = await measureDatabaseTransfer(
      ctx.databaseUrl,
      async (db) => {
        const prepared = await prepareConnectionBases(db, candidates);
        for (const raw of candidates)
          expect(
            canonicalJson(
              await captureConnectionBasis(db, raw, false, prepared),
            ),
          ).toBe(canonicalJson(await captureConnectionBasis(db, raw)));
      },
    );
    expect(measured.largestValueBytes).toBeLessThan(64 * 1024);
  });
});

// Rediscovery follows the source's authoritative snapshot: a relevant field
// change refreshes it and an irrelevant one does not.
describe("connection discovery fingerprint", () => {
  const ctx = withTestDb();

  it("changes with the source's connection-relevant fields only", async () => {
    const created = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic fingerprint drill" }),
      ctx.actor,
    );
    const source: Parameters<typeof connectionDiscoveryFingerprint>[1] = {
      entityKind: "product",
      entityId: created.id,
    };
    const before = await connectionDiscoveryFingerprint(ctx.db, source);
    await getDb(ctx.db)
      .update(productTable)
      .set({ tags: ["synthetic unrelated tag"] })
      .where(eq(productTable.id, created.entityId));
    expect(await connectionDiscoveryFingerprint(ctx.db, source)).toBe(before);
    await getDb(ctx.db)
      .update(productTable)
      .set({ name: "Synthetic fingerprint driver" })
      .where(eq(productTable.id, created.entityId));
    expect(await connectionDiscoveryFingerprint(ctx.db, source)).not.toBe(
      before,
    );
  });
});
