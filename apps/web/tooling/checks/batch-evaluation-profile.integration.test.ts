import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { and, eq, sql, SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { countTestDbQueries, withTestDb } from "tooling/test-setup";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { aiEvaluationTarget } from "@cubby/schemas/ai-evaluation";
import { fromPartial } from "@total-typescript/shoehorn";
import { acceptedSourceOrder } from "@cubby/schemas/purchase-import";
import type { ProductId } from "@cubby/schemas/identifiers";
import { createRepoIdentity } from "tooling/factories/repo";

import { setCfEnv } from "~/server/cf-env";
import {
  seedEntityEmbedding,
  findSimilarEntities,
} from "~/server/generic/embedding/repo/entity-embedding";
import { getSemanticEmbeddingConfig } from "~/server/generic/embedding/service/semantic/config";
import {
  createInMemoryVectorizeIndex,
  productionVectorStore,
} from "~/server/generic/embedding/service/semantic/vector-store";
import {
  refreshSearchDocument,
  getSearchDocumentEmbeddingText,
} from "~/server/generic/search/repo/search-document";
import { settleEmbeddingProjectionJobs } from "~/server/generic/embedding/repo/embedding-job.fixtures";
import type { DecisionPort } from "~/server/ai/decision-model";
import * as identity from "~/server/ai/product-identity";
import * as evaluations from "~/server/ai/repo/ai-evaluation";
import { activateAiRefresh } from "~/server/ai/repo/ai-refresh";
import { getDb, withTransactionDatabase } from "~/server/db/helpers";
import {
  aiEvaluation,
  job,
  product,
  importSourceClaim,
  importSourceOrder,
  importSourceProduct,
  externalSource,
  ledgerParty,
} from "~/server/db/schema";
import * as publication from "~/server/domains/product/repo/match/product-match-candidate";
import * as snapshot from "~/server/domains/product/repo/match/product-identity-snapshot";
import * as fences from "~/server/domains/product/repo/match/product-identity-fence";
import * as claims from "~/server/domains/product/repo/product-identity-claims";
import * as attempts from "~/server/domains/run/repo/ai-work-state";
import { discoverAiRefresh } from "~/server/domains/run/service/ai-refresh";
import { kernelCtx } from "~/server/domains/run/service/suggestion-sweep.fixtures";
import * as jobExecution from "~/server/generic/jobs/repo/execution";
import * as jobRepo from "~/server/generic/jobs/repo/jobs";
import { advanceJob } from "~/server/generic/jobs/service/jobs";
import { drainDerivedRefreshFrontier } from "~/server/testing/background-queue";
import {
  createProductIdentityFixture,
  makeProductInput,
  createImageFixture,
  insertEntityAttachments,
} from "~/server/testing/repo.fixtures";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import { attachPurchaseProducts } from "~/server/domains/purchase/repo/purchase-products";
import { publishAssessments } from "~/server/generic/assessment/repo/assessment";
import { rebuildAssessmentStates } from "~/server/generic/assessment/repo/assessment-state";
import { reviewAssessment } from "~/server/generic/assessment/repo/assessment-review";
import { aiEvaluationJobHandler } from "~/server/workflows/runs/job-execution";

// Disposable baseline probe: real repositories, transactions and Job handler;
// the external model alone is deterministic. Nested counters are exclusive:
// countTestDbQueries shadows its parent's AsyncLocalStorage measurement.
describe("batch evaluation baseline profile", () => {
  const ctx = withTestDb();
  let enabled = false;
  let calls = 0;
  const inputBytes: number[] = [];
  const observations: {
    stage: string;
    queries: number;
    ms: number;
    statements: string[];
  }[] = [];
  const choose: DecisionPort = async (input) => {
    calls++;
    inputBytes.push(new TextEncoder().encode(JSON.stringify(input)).byteLength);
    const keys = Object.keys(input.questions.selection.criteria);
    const choice = keys[3] ?? keys[0]!;
    return {
      answers: {
        selection: {
          type: "choice",
          choice,
          confidence: 0.7,
          probabilities: Object.fromEntries(
            keys.map((key) => [
              key,
              key === choice ? 0.7 : 0.3 / (keys.length - 1),
            ]),
          ),
        },
      },
    };
  };
  async function measure<T>(stage: string, work: () => Promise<T>): Promise<T> {
    if (!enabled) return work();
    const start = performance.now();
    const measured = await countTestDbQueries(work);
    observations.push({
      stage,
      queries: measured.queryCount,
      ms: performance.now() - start,
      statements: measured.statements,
    });
    return measured.result;
  }
  const original = {
    claim: evaluations.claimAiEvaluation,
    guard: evaluations.guardAiEvaluation,
    publish: evaluations.publishAiEvaluation,
    attempt: attempts.guardAiEvaluationAttempt,
    current: jobExecution.assertCurrentJob,
    jobClaim: jobRepo.claimJob,
    source: snapshot.productIdentitySnapshot,
    pair: snapshot.prepareProductIdentityPair,
    request: snapshot.prepareProductIdentityPairRequests,
    catalog: identity.prepareProductIdentityCatalog,
    decision: identity.evaluatePreparedProductIdentityPair,
    publication: publication.prepareProductPairPublication,
    fence: fences.productIdentityEvidenceFence,
    claims: claims.loadProductIdentifierClaims,
  };
  beforeEach(() => {
    enabled = false;
    vi.spyOn(evaluations, "claimAiEvaluation").mockImplementation((...args) =>
      measure("claim.evaluation", () => original.claim(...args)),
    );
    vi.spyOn(evaluations, "guardAiEvaluation").mockImplementation((...args) =>
      measure("fences.evaluation", () => original.guard(...args)),
    );
    vi.spyOn(evaluations, "publishAiEvaluation").mockImplementation((...args) =>
      measure("publication.receipts", () => original.publish(...args)),
    );
    vi.spyOn(attempts, "guardAiEvaluationAttempt").mockImplementation(
      (...args) => measure("fences.attempt", () => original.attempt(...args)),
    );
    vi.spyOn(jobExecution, "assertCurrentJob").mockImplementation((...args) =>
      measure("fences.job", () => original.current(...args)),
    );
    vi.spyOn(jobRepo, "claimJob").mockImplementation((...args) =>
      measure("claim.job", () => original.jobClaim(...args)),
    );
    vi.spyOn(snapshot, "productIdentitySnapshot").mockImplementation(
      (...args) => measure("context.source", () => original.source(...args)),
    );
    vi.spyOn(snapshot, "prepareProductIdentityPair").mockImplementation(
      (...args) => measure("context.pair", () => original.pair(...args)),
    );
    vi.spyOn(claims, "loadProductIdentifierClaims").mockImplementation(
      (...args) =>
        measure(args[1] ? "context.claims" : "candidates.catalog_claims", () =>
          original.claims(...args),
        ),
    );
    vi.spyOn(identity, "prepareProductIdentityCatalog").mockImplementation(
      (...args) =>
        measure("candidates.catalog", () => original.catalog(...args)),
    );
    vi.spyOn(
      identity,
      "evaluatePreparedProductIdentityPair",
    ).mockImplementation((db, pair, runId, options) =>
      measure("decision", () =>
        original.decision(db, pair, runId, {
          ...options,
          decisionPort: choose,
        }),
      ),
    );
    vi.spyOn(fences, "productIdentityEvidenceFence").mockImplementation(
      (...args) => measure("fences.evidence", () => original.fence(...args)),
    );
    vi.spyOn(snapshot, "prepareProductIdentityPairRequests").mockImplementation(
      async (...args) => {
        const publishers = await measure("publication.prepare_request", () =>
          original.request(...args),
        );
        return publishers.map(
          (publish) => (db) =>
            measure("publication.request", () => publish(db)),
        );
      },
    );
    vi.spyOn(publication, "prepareProductPairPublication").mockImplementation(
      async (...args) => {
        const publish = await measure("publication.prepare_assessment", () =>
          original.publication(...args),
        );
        return (db) => measure("publication.assessment", () => publish(db));
      },
    );
  });

  it("profiles snapshot set cardinality", async () => {
    const ids: ProductId[] = [];
    for (let index = 0; index < 100; index++) {
      const created = await createProductIdentityFixture(
        ctx.db,
        makeProductInput({ name: `Synthetic snapshot ${index}` }),
        ctx.actor,
      );
      ids.push(created.entityId);
    }
    const results = [];
    for (const size of [1, 100]) {
      const start = performance.now();
      const measured = await countTestDbQueries(() =>
        snapshot.productIdentitySnapshots(ctx.db, ids.slice(0, size)),
      );
      results.push({
        size,
        queryCount: measured.queryCount,
        elapsedMs: performance.now() - start,
        returned: measured.result.size,
        statements: measured.statements,
      });
      expect(measured.result.size).toBe(size);
    }
    const directory = resolve(
      import.meta.dirname,
      "../../../../artifacts/batch-evaluation-profile",
    );
    await mkdir(directory, { recursive: true });
    await writeFile(
      resolve(directory, "snapshot-sets.json"),
      JSON.stringify(results, null, 2),
    );
  }, 120_000);

  for (const candidates of [0, 1, 4, 12])
    it(`profiles ${candidates} synthetic candidates`, async () => {
      const source = await createProductIdentityFixture(
        ctx.db,
        makeProductInput({ name: "Synthetic profile source" }),
        ctx.actor,
      );
      for (let index = 0; index < candidates; index++)
        await createProductIdentityFixture(
          ctx.db,
          makeProductInput({
            name: `Synthetic profile candidate ${index}`,
            aliases: ["Synthetic profile source"],
          }),
          ctx.actor,
        );
      await activateAiRefresh(ctx.db, "synthetic-page-profile", {
        enabled: true,
      });
      await discoverAiRefresh(ctx.db, { context: kernelCtx(ctx) });
      await drainDerivedRefreshFrontier(ctx.db);
      const [target] = await getDb(ctx.db)
        .select()
        .from(aiEvaluation)
        .where(
          and(
            sql`${aiEvaluation.target}->>${"kind"} = ${aiEvaluationTarget.options[2].shape.kind.value}`,
            sql`${aiEvaluation.target}->>'recordId' = ${source.entityId}`,
          ),
        );
      expect(target).toBeDefined();
      const results: Awaited<ReturnType<typeof execute>>[] = [];
      async function execute(id: string, kind: string) {
        const [execution] = await getDb(ctx.db)
          .select()
          .from(job)
          .where(eq(job.key, `ai-evaluation:${id}`));
        expect(execution).toBeDefined();
        observations.length = 0;
        calls = 0;
        inputBytes.length = 0;
        enabled = true;
        const start = performance.now();
        const outcome = await measure("job.lifecycle_and_handler", () =>
          advanceJob(ctx.db, execution!.id, {
            "ai.evaluation": aiEvaluationJobHandler,
          }),
        );
        const elapsedMs = performance.now() - start;
        enabled = false;
        const [saved] = await getDb(ctx.db)
          .select()
          .from(aiEvaluation)
          .where(eq(aiEvaluation.id, id));
        const profile = {
          kind,
          outcome,
          state: saved?.state,
          receipt: saved?.receipt,
          elapsedMs,
          modelCalls: calls,
          modelInputBytes: [...inputBytes],
          totalQueries: observations.reduce((sum, row) => sum + row.queries, 0),
          observations: structuredClone(observations),
        };
        expect(outcome).toBe("succeeded");
        expect(saved?.state).toBe("completed");
        return profile;
      }
      results.push(await execute(target!.id, "product"));
      const pairTargets = await getDb(ctx.db)
        .select()
        .from(aiEvaluation)
        .where(
          sql`${aiEvaluation.target}->>${"kind"} = ${aiEvaluationTarget.options[1].shape.kind.value}`,
        );
      for (const pair of pairTargets)
        results.push(await execute(pair.id, "product_pair"));
      const directory = resolve(
        import.meta.dirname,
        "../../../../artifacts/batch-evaluation-profile",
      );
      await mkdir(directory, { recursive: true });
      await writeFile(
        resolve(directory, `candidates-${candidates}.json`),
        JSON.stringify(
          { candidates, catalogSize: candidates + 1, results },
          null,
          2,
        ),
      );
    }, 120_000);
});

// Lane B's durable acceptance checks use actual PostgreSQL, including retained
// receipts, selected-description reads and conflict ancestors. No model or
// repository is mocked. The original execution probes above remain comparable.
describe("Product identity page preparation", () => {
  const ctx = withTestDb();
  afterEach(() => setCfEnv(undefined));
  const directory = resolve(
    import.meta.dirname,
    "../../../../artifacts/batch-evaluation-profile",
  );
  async function save(name: string, value: unknown) {
    await mkdir(directory, { recursive: true });
    await writeFile(resolve(directory, name), JSON.stringify(value, null, 2));
  }
  async function seed(count: number, degree: number) {
    const ids: ProductId[] = [];
    for (let index = 0; index < count; index++) {
      const group = Math.floor(index / (degree + 1));
      const created = await createProductIdentityFixture(
        ctx.db,
        makeProductInput({
          name: `Synthetic page ${index}`,
          aliases: [`Synthetic group ${group}`],
        }),
        ctx.actor,
      );
      ids.push(created.entityId);
    }
    return ids;
  }
  async function retainEvidence(
    ids: readonly ProductId[],
    pairIds: readonly snapshot.ProductIdentityPairIds[],
  ) {
    const seller = await createRepoIdentity(ctx, "vendor", {
      name: "Synthetic page seller",
      website: "https://catalog.example.test",
    });
    const buyer = await createRepoIdentity(ctx, "ledgerParty", {
      name: "Synthetic page buyer",
      kind: "member",
    });
    await getDb(ctx.db)
      .update(ledgerParty)
      .set({ userId: ctx.actor.userId })
      .where(eq(ledgerParty.id, buyer.entityId));
    const runId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "ai_suggest",
      trigger: "manual",
      status: "running",
    });
    const purchase = await createRepoIdentity(ctx, "purchase", {
      vendorId: seller.output.id,
      date: "2026-01-01",
    });
    await getDb(ctx.db).insert(externalSource).values({
      slug: "synthetic-page-seller",
      label: "Synthetic page seller",
      vendorId: seller.entityId,
      issuer: true,
    });
    await attachPurchaseProducts(
      ctx.db,
      purchase.entityId,
      [...ids],
      ctx.actor,
    );
    const original = acceptedSourceOrder.parse({
      checksum: "c".repeat(64),
      extraction: {
        status: "ready",
        candidate: {
          orderId: "synthetic-page-order",
          orderedAt: "2026-01-01T00:00:00.000Z",
          merchant: "Synthetic page seller",
          currency: "USD",
          printedGrandTotal: ids.length * 10,
          lines: ids.map((_, index) => ({
            title: `Synthetic receipt line ${index}`,
            amount: 10,
            lineKind: "principal",
            sku: `SYNTH-PAGE-${index}`,
            productUrl: `https://catalog.example.test/p/${index}`,
          })),
          payments: [],
          allShipmentsDelivered: false,
        },
      },
    });
    const [claim] = await getDb(ctx.db)
      .insert(importSourceClaim)
      .values({
        ledgerPartyId: buyer.entityId,
        kind: "vendor_export",
        externalKey: "synthetic-page-order",
        checksum: original.checksum,
        firstRunId: runId,
        lastRunId: runId,
      })
      .returning();
    if (!claim) throw new Error("Missing synthetic claim");
    const [order] = await getDb(ctx.db)
      .insert(importSourceOrder)
      .values({
        sourceClaimId: claim.id,
        orderKey: "synthetic-page-order",
        purchaseId: purchase.entityId,
        checksum: original.checksum,
        outputFingerprint: "d".repeat(64),
        originalOrder: original,
      })
      .returning();
    if (!order) throw new Error("Missing synthetic order");
    await getDb(ctx.db)
      .insert(importSourceProduct)
      .values(
        ids.map((productId, lineIndex) => ({
          sourceOrderId: order.id,
          lineIndex,
          productId,
          expenseId: null,
        })),
      );
    for (const [index, id] of ids.entries()) {
      const image = await createImageFixture(ctx.db, `synthetic-page-${index}`);
      await insertEntityAttachments(ctx.db, [
        { entityId: id, imageId: image.id },
      ]);
    }
    const ancestors = await publishAssessments(
      ctx.db,
      pairIds.map((pair, index) => {
        const [recordId, otherId] = [...pair].sort();
        return {
          input: {
            publicationKey: `synthetic-page-ancestor:${index}`,
            family: "product_pair",
            producer: null,
            fingerprint: null,
            subject: {
              kind: "product_pair",
              entity: "product",
              recordId: recordId!,
              otherId: otherId!,
            },
            judgment: { actionable: false, conflict: true },
            evidence: { conflict: true },
            served: false,
          },
        };
      }),
    );
    await publishAssessments(
      ctx.db,
      pairIds.map((pair, index) => {
        const [recordId, otherId] = [...pair].sort();
        return {
          input: {
            publicationKey: `synthetic-page-history:${index}`,
            family: "product_pair",
            producer: null,
            fingerprint: null,
            subject: {
              kind: "product_pair",
              entity: "product",
              recordId: recordId!,
              otherId: otherId!,
            },
            judgment: { actionable: false, conflict: false },
            evidence: {
              conflict: false,
              signals: { conflictLineage: [ancestors[index]!.id] },
            },
          },
        };
      }),
    );
  }
  it("keeps populated source and canonical-pair preparation at a fixed statement budget", async () => {
    const ids = await seed(200, 1);
    const sources = ids.filter((_, index) => index % 2 === 0);
    const pairIds = sources.map(
      (id, index) => [id, ids[index * 2 + 1]!] as const,
    );
    await retainEvidence(ids, pairIds);
    const reports = [];
    const rawQueries: SQL[] = [];
    const client = getDb(ctx.db),
      execute = client.execute.bind(client);
    const spy = vi.spyOn(client, "execute").mockImplementation((query) => {
      if (query instanceof SQL) rawQueries.push(query);
      return execute(query);
    });
    for (const kind of ["product", "product_pair"] as const) {
      const counts: number[] = [],
        statementsBySize: string[][] = [];
      for (const size of [1, 100]) {
        const targets = sources
          .slice(0, size)
          .map((recordId, index) =>
            kind === "product"
              ? { key: recordId, kind, recordId }
              : { key: recordId, kind, recordId, otherId: pairIds[index]![1] },
          );
        const start = performance.now();
        const measured = await countTestDbQueries(() =>
          identity.prepareProductIdentityPage(ctx.db, targets),
        );
        counts.push(measured.queryCount);
        statementsBySize.push(
          measured.statements.map(
            (statement) =>
              statement
                .replace(/\$\d+/gu, "?")
                .split(/\b(?:VALUES|IN)\s*\(/iu)[0]!,
          ),
        );
        expect(measured.result).toHaveLength(size);
        expect(
          measured.result.every(
            (outcome) =>
              outcome.valid &&
              outcome.eligible &&
              outcome.pairs.length === 1 &&
              outcome.pairs[0]?.verification === "pending_verification",
          ),
        ).toBe(true);
        reports.push({
          kind,
          size,
          queryCount: measured.queryCount,
          elapsedMs: performance.now() - start,
          statements: measured.statements,
        });
      }
      await save("lane-b-preparation-counts.json", { reports });
      expect(counts[0]).toBe(counts[1]);
      expect(counts[1]).toBeLessThanOrEqual(15);
      expect(statementsBySize[0]).toEqual(statementsBySize[1]);
    }
    spy.mockRestore();
    const plans = [];
    const dialect = new PgDialect();
    const catalogQueries = rawQueries
      .filter((query) =>
        dialect.sqlToQuery(query).sql.includes("names AS MATERIALIZED"),
      )
      .slice(-1);
    for (const query of [...catalogQueries, ...rawQueries.slice(-4)])
      plans.push(
        await client.execute(
          sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query}`,
        ),
      );
    const publications = [];
    for (const size of [1, 25]) {
      const selected = size === 1 ? pairIds.slice(0, 1) : pairIds.slice(1, 26);
      const prepared = await publication.prepareProductPairPublications(
        ctx.db,
        selected.map((productIds, index) => ({
          key: `publication:${size}:${index}`,
          input: {
            productIds,
            source: "agent",
            evidence: "Synthetic bulk publication",
            sourceUrls: [],
            actionable: true,
          },
        })),
      );
      const started = performance.now();
      const measured = await countTestDbQueries(() =>
        withTransactionDatabase(
          ctx.db,
          (tx) => identity.publishProductIdentityChunk(tx, prepared),
          { isolationLevel: "serializable" },
        ),
      );
      expect(measured.result).toHaveLength(size);
      expect(
        measured.result.every(
          (outcome) =>
            outcome.valid &&
            // Publication retains the explicit agent judgment; the historical
            // conflict remains an independent verification guard.
            outcome.row.actionable &&
            outcome.row.verification === "pending_verification",
        ),
      ).toBe(true);
      publications.push({
        size,
        queryCount: measured.queryCount,
        elapsedMs: performance.now() - started,
        statements: measured.statements,
      });
    }
    expect(publications[0]?.queryCount).toBe(publications[1]?.queryCount);
    await save("lane-b-preparation.json", { reports, plans, publications });
  }, 240_000);

  it("publishes one immutable pair for duplicate requests, preserves dismissals and isolates stale siblings", async () => {
    const ids = await seed(6, 1);
    const inputs = [0, 2, 4].map((index) => ({
      key: `request:${index}`,
      input: {
        productIds: [ids[index]!, ids[index + 1]!] as const,
        source: "agent" as const,
        evidence: "Synthetic pair evidence",
        sourceUrls: [],
      },
    }));
    const initial = await publication.prepareProductPairPublications(
      ctx.db,
      inputs,
    );
    const [first] = await withTransactionDatabase(
      ctx.db,
      (tx) => publication.publishProductPairPublications(tx, initial),
      { isolationLevel: "serializable" },
    );
    expect(first?.valid).toBe(true);
    if (!first?.valid) return;
    await reviewAssessment(ctx.db, kernelCtx(ctx), {
      assessmentId: first.row.id,
      operationId: crypto.randomUUID(),
      verdict: "dismissed",
      suppression: {
        scope: "product_pair",
        candidateKey: publication.productPairKey(
          ...inputs[0]!.input.productIds,
        ),
        fingerprint: null,
      },
      correction: { present: false },
      intent: "history",
    });
    const updated = await publication.prepareProductPairPublications(
      ctx.db,
      inputs.map((entry) => ({
        ...entry,
        input: { ...entry.input, evidence: "Synthetic revised pair evidence" },
      })),
    );
    const duplicate = { ...updated[0]!, key: "duplicate-source-request" };
    await getDb(ctx.db)
      .update(product)
      .set({ name: "Synthetic stale sibling" })
      .where(eq(product.id, ids[2]!));
    const outcomes = await withTransactionDatabase(
      ctx.db,
      (tx) =>
        publication.publishProductPairPublications(tx, [...updated, duplicate]),
      { isolationLevel: "serializable" },
    );
    expect(outcomes.map((outcome) => outcome.valid)).toEqual([
      true,
      false,
      true,
      true,
    ]);
    expect(outcomes[0]?.row?.id).toBe(outcomes[3]?.row?.id);
    expect(outcomes[0]?.row?.state).toBe("dismissed");
    const activeIds = outcomes.flatMap((outcome) =>
      outcome.valid ? [outcome.row.id] : [],
    );
    const replayed = await rebuildAssessmentStates(ctx.db, [
      ...new Set(activeIds),
    ]);
    expect(
      replayed.find((row) => row.id === outcomes[0]?.row?.id)?.suppression
        ?.scope,
    ).toBe("product_pair");
  }, 120_000);

  it("batches semantic metadata while retaining standalone candidate validation and coverage", async () => {
    const index = createInMemoryVectorizeIndex();
    setCfEnv(
      fromPartial<Env & { CUBBY_TEST_AI_GATEWAY: { fetch: typeof fetch } }>({
        VECTORIZE: index,
        BACKGROUND_QUEUE: { sendBatch: async () => {} },
        CUBBY_TEST_AI_GATEWAY: {
          fetch: async () => {
            throw new Error("Unexpected synthetic provider call");
          },
        },
      }),
    );
    const config = getSemanticEmbeddingConfig(),
      ids = await seed(100, 1);
    const values = Array.from({ length: config.dimensions }, (_, axis) =>
      axis === 0 ? 1 : 0,
    );
    for (const id of ids) {
      await refreshSearchDocument(ctx.db, "product", id);
      const text = await getSearchDocumentEmbeddingText(ctx.db, "product", id);
      if (!text) throw new Error("Missing synthetic semantic document");
      const artifactId = await seedEntityEmbedding(ctx.db, {
        ...text,
        config,
        values,
      });
      await index.upsert([
        { id: artifactId, values, metadata: { entityType: "product" } },
      ]);
    }
    await settleEmbeddingProjectionJobs(ctx.db);
    const observations = [];
    for (const size of [1, 100]) {
      const started = performance.now();
      const measured = await countTestDbQueries(() =>
        identity.retrieveProductIdentityCandidatePage(
          ctx.db,
          ids.slice(0, size),
        ),
      );
      expect(measured.result.sources.size).toBe(size);
      expect(
        [...measured.result.sources.values()].every(
          (row) => row.coverage.semanticNeighbours.status === "queried",
        ),
      ).toBe(true);
      observations.push({
        size,
        statements: measured.queryCount,
        elapsedMs: performance.now() - started,
      });
    }
    expect(observations[0]?.statements).toBe(observations[1]?.statements);
    const direct = await findSimilarEntities(
      ctx.db,
      productionVectorStore,
      { entityKind: "product", entityId: ids[0]! },
      { targetType: "product", limit: 20, config },
    );
    const page = await identity.retrieveProductIdentityCandidatePage(ctx.db, [
      ids[0]!,
    ]);
    expect(page.sources.get(ids[0]!)?.candidates).toEqual(
      expect.arrayContaining(direct.candidates.map((row) => row.entityId)),
    );
    await getDb(ctx.db)
      .update(product)
      .set({ name: "Synthetic stale semantic seed" })
      .where(eq(product.id, ids[0]!));
    const stale = await identity.retrieveProductIdentityCandidatePage(
      ctx.db,
      ids.slice(0, 2),
    );
    expect(stale.sources.get(ids[0]!)?.coverage.semanticNeighbours.status).toBe(
      "failed",
    );
    expect(stale.sources.get(ids[1]!)?.coverage.semanticNeighbours.status).toBe(
      "failed",
    );
    expect(stale.sources.get(ids[1]!)?.candidates).toContain(ids[2]!);
    await save("lane-b-semantic.json", { observations });
  }, 240_000);

  it.skipIf(process.env.CUBBY_PROFILE_FULL_CATALOG !== "1")(
    "profiles preparation for 5,000 Products with degree four",
    async () => {
      const setup = performance.now();
      const ids = await seed(5_000, 4);
      await retainEvidence(
        ids.slice(0, 100),
        ids
          .slice(0, 100)
          .map(
            (id, index) =>
              [
                id,
                ids[Math.floor(index / 5) * 5 + ((index + 1) % 5)]!,
              ] as const,
          ),
      );
      const setupMs = performance.now() - setup;
      const pages = [],
        started = performance.now();
      let pairCount = 0;
      for (let offset = 0; offset < ids.length; offset += 100) {
        const start = performance.now();
        const measured = await countTestDbQueries(() =>
          identity.prepareProductIdentityPage(
            ctx.db,
            ids.slice(offset, offset + 100).map((recordId) => ({
              key: recordId,
              kind: "product",
              recordId,
            })),
          ),
        );
        pairCount += measured.result.reduce(
          (sum, row) => sum + row.pairs.length,
          0,
        );
        expect(
          measured.result.every((row) => row.valid && row.pairs.length === 4),
        ).toBe(true);
        pages.push({
          offset,
          queryCount: measured.queryCount,
          elapsedMs: performance.now() - start,
        });
      }
      expect(pairCount).toBe(20_000);
      await getDb(ctx.db)
        .update(product)
        .set({
          aliases: Array.from(
            { length: 26 },
            (_, index) => `Synthetic group ${index}`,
          ),
        })
        .where(eq(product.id, ids[0]!));
      const skewStarted = performance.now();
      const skew = await countTestDbQueries(() =>
        identity.prepareProductIdentityPage(ctx.db, [
          { key: "skew", kind: "product", recordId: ids[0]! },
        ]),
      );
      const skewMs = performance.now() - skewStarted;
      expect(skew.result[0]?.pairs.length).toBe(129);

      await save("lane-b-full-catalog.json", {
        seed: "synthetic-page-group-v1",
        products: 5_000,
        degree: 4,
        pairEdges: pairCount,
        canonicalPairs: 10_000,
        setupMs,
        skew: {
          pairs: skew.result[0]?.pairs.length,
          statements: skew.queryCount,
          elapsedMs: skewMs,
        },
        preparationMs: performance.now() - started,
        pages,
        heapBytes: process.memoryUsage().heapUsed,
        node: process.version,
        platform: process.platform,
        arch: process.arch,
      });
    },
    1_200_000,
  );
});
