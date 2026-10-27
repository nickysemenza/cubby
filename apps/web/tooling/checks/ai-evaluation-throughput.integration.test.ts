import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { acceptedSourceOrder } from "@cubby/schemas/purchase-import";
import { assessmentFamily } from "@cubby/schemas/assessment";
import { aiEvaluationState } from "@cubby/schemas/ai-evaluation";
import type { ActorContext } from "@cubby/schemas/context";
import { parseEntityId, type ProductId } from "@cubby/schemas/identifiers";
import { fromPartial } from "@total-typescript/shoehorn";
import * as models from "@cubby/shared/ai/models";
import { desc, and, eq, inArray, notInArray, sql } from "drizzle-orm";
import { createRepoIdentity } from "tooling/factories/repo";
import { countTestDbQueries, withTestDb } from "tooling/test-setup";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import {
  aiEvaluation,
  aiEvaluationRequest,
  assessment,
  assessmentState,
  job,
  jobInvalidation,
  run,
  product,
  importSourceClaim,
  importSourceOrder,
  importSourceProduct,
  externalSource,
  ledgerParty,
} from "~/server/db/schema";
import { gatewayEgressInput } from "~/server/ai/gateway-egress-contract";
import {
  activateAiRefresh,
  saveAiDiscoveryCursor,
} from "~/server/ai/repo/ai-refresh";
import { setCfEnv } from "~/server/cf-env";
import * as snapshot from "~/server/domains/product/repo/match/product-identity-snapshot";
import { attachPurchaseProducts } from "~/server/domains/purchase/repo/purchase-products";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import { discoverAiRefresh } from "~/server/domains/run/service/ai-refresh";
import { kernelCtx } from "~/server/domains/run/service/suggestion-sweep.fixtures";
import { publishAssessments } from "~/server/generic/assessment/repo/assessment";
import { jobRunOwned } from "~/server/generic/jobs/repo/external-claim";
import {
  jobDue,
  unobservedJobInvalidation,
} from "~/server/generic/jobs/repo/queue";
import { drainDueJobs } from "~/server/generic/jobs/service/jobs";
import {
  createProductIdentityFixture,
  makeProductInput,
  createImageFixture,
  insertEntityAttachments,
} from "~/server/testing/repo.fixtures";
import {
  aiEvaluationJobHandler,
  runJobHandler,
} from "~/server/workflows/runs/job-execution";

const count = Number(process.env.CUBBY_PAGE_CATALOG_SIZE ?? 5000);
const scenarios = [
  { routing: "all-jev", latency: 0 },
  { routing: "normal", latency: 0 },
  { routing: "all-jev", latency: 250 },
  { routing: "normal", latency: 250 },
].filter(
  (entry) =>
    !process.env.CUBBY_PAGE_SCENARIO ||
    process.env.CUBBY_PAGE_SCENARIO === `${entry.routing}:${entry.latency}`,
);

async function seedFixture(db: Database, actor: ActorContext) {
  const ctx = { db, actor };
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

  const ids = await seed(count, 4);
  await retainEvidence(
    ids.slice(0, Math.min(count, 100)),
    ids
      .slice(0, Math.min(count, 100))
      .map(
        (id, index) =>
          [id, ids[Math.floor(index / 5) * 5 + ((index + 1) % 5)]!] as const,
      ),
  );
  return { ids };
}

// Explicit experiment: no wall-clock assertion in normal CI. Only synthetic records.
describe.skipIf(process.env.CUBBY_PAGE_THROUGHPUT !== "1")(
  "complete Product evaluation re-check throughput",
  () => {
    const ctx = withTestDb();
    afterEach(() => {
      setCfEnv();
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    });
    it.each(scenarios)(
      "settles $routing at $latency ms through Run completion",
      async ({ routing, latency }) => {
        const setupStarted = performance.now();
        const seeded = await ctx.fixture(
          `synthetic-evaluation-throughput-${count}-v1`,
          seedFixture,
        );
        expect(seeded.ids).toHaveLength(count);
        await getDb(ctx.db)
          .update(product)
          .set({ name: sql`${product.name} || ${` ${routing} ${latency}`}` });
        // Auxiliary device/derived work was created by real fixture writers. Park it
        // outside the measured catalog workload; no provider other than decisions runs.
        await getDb(ctx.db)
          .update(job)
          .set({ state: "paused" })
          .where(notInArray(job.kind, ["ai.evaluation", "run.execute"]));
        if (routing === "all-jev")
          vi.spyOn(models, "selectDecisionModel").mockReturnValue(
            "typesafe/jev",
          );
        vi.stubEnv("AI_GATEWAY_API_KEY", "synthetic-throughput-token");
        const calls: { model: string; questions: number; bytes: number }[] = [];
        let active = 0,
          peakRequests = 0;
        setCfEnv(
          fromPartial<Env>({
            AI_GATEWAY_EGRESS: {
              getByName: () =>
                fromPartial<ReturnType<Env["AI_GATEWAY_EGRESS"]["getByName"]>>({
                  fetch: async (request: Request) => {
                    const input = gatewayEgressInput.parse(
                      await request.json(),
                    );
                    const questionInput = fromPartial<{
                      state: string;
                      questions: Record<
                        string,
                        { criteria: Record<string, string> }
                      >;
                    }>(input.query);
                    calls.push({
                      model: input.endpoint.replace("run/", ""),
                      questions: Object.keys(questionInput.questions).length,
                      bytes: new TextEncoder().encode(
                        JSON.stringify(input.query),
                      ).byteLength,
                    });
                    active++;
                    peakRequests = Math.max(peakRequests, active);
                    if (latency)
                      await new Promise<void>((resolve) =>
                        setTimeout(resolve, latency),
                      );
                    active--;
                    return Response.json({
                      result: {
                        usage: {
                          input_tokens:
                            100 * Object.keys(questionInput.questions).length,
                          output_tokens:
                            10 * Object.keys(questionInput.questions).length,
                        },
                        answers: Object.fromEntries(
                          Object.entries(questionInput.questions).map(
                            ([id, question]) => {
                              const keys = Object.keys(question.criteria);
                              return [
                                id,
                                {
                                  type: "choice",
                                  choice: keys[3] ?? keys[0],
                                  confidence: 0.7,
                                  probabilities: Object.fromEntries(
                                    keys.map((key, index) => [
                                      key,
                                      index === 3
                                        ? 0.7
                                        : 0.3 / (keys.length - 1),
                                    ]),
                                  ),
                                },
                              ];
                            },
                          ),
                        ),
                      },
                    });
                  },
                }),
            },
          }),
        );
        const output = resolve(process.cwd(), "../../artifacts/page-execution");
        await mkdir(output, { recursive: true });
        const setupMs = performance.now() - setupStarted;
        const cycles = [];
        let peakHeap = process.memoryUsage().heapUsed;
        const memory = setInterval(() => {
          peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
        }, 100);
        try {
          for (const cacheState of ["cold", "warm-tail", "skew"] as const) {
            // A policy generation re-admits durable demand without changing prompts.
            // Restoring the compiled policy keeps the actual Worker manifest fence.
            if (cacheState === "warm-tail") {
              const previous = await activateAiRefresh(
                ctx.db,
                "synthetic-before-warm",
                { enabled: true },
              );
              const manifest = structuredClone(previous.manifest);
              manifest["product-identity"]!.policyFingerprint +=
                ":synthetic-readmission";
              await activateAiRefresh(ctx.db, "synthetic-readmission", {
                enabled: true,
                manifest,
              });
            }
            if (cacheState === "skew")
              await getDb(ctx.db)
                .update(product)
                .set({
                  aliases: Array.from(
                    { length: 26 },
                    (_, index) => `Synthetic group ${index}`,
                  ),
                })
                .where(
                  eq(product.id, parseEntityId("product", seeded.ids[0]!)),
                );
            const activation = await activateAiRefresh(
              ctx.db,
              "synthetic-full-recheck",
              { enabled: true },
            );
            await saveAiDiscoveryCursor(ctx.db, {
              revision: activation.revision,
              field: null,
              email: null,
              product: null,
              connection: null,
              fieldDone: true,
              emailDone: true,
              productDone: false,
              connectionDone: true,
            });
            const firstCall = calls.length;
            let planMs = 0;
            const planPair = async () => {
              const eligibility = sql`e.feature=${"product-identity"} AND e."executionKind"=${"ai_refresh"} AND e.target->>${"kind"}=${"product"} AND e.state IN (${aiEvaluationState.enum.queued}, ${aiEvaluationState.enum.retry_wait}, ${aiEvaluationState.enum.running}, ${aiEvaluationState.enum.result_ready})`;
              const predicates = {
                correlated: sql`EXISTS (SELECT 1 FROM "AiEvaluation" e WHERE ${job.key}='ai-evaluation:' || e.id::text AND ${job.input}->>'evaluationId'=e.id::text AND ${eligibility})`,
                membership: sql`${job.key}='ai-evaluation:' || (${job.input}->>'evaluationId') AND ${job.key} IN (SELECT 'ai-evaluation:' || e.id::text FROM "AiEvaluation" e WHERE ${eligibility} OFFSET 0)`,
              };
              const [anchor] = await getDb(ctx.db)
                .select({ owned: jobRunOwned() })
                .from(job)
                .where(eq(job.kind, "ai.evaluation"))
                .limit(1);
              const plans = [];
              for (const [name, predicate] of Object.entries(predicates)) {
                const query = getDb(ctx.db)
                  .select({
                    row: job,
                    pendingCapture: unobservedJobInvalidation(),
                    markerRestartsPass: jobInvalidation.restartsPass,
                  })
                  .from(job)
                  .leftJoin(jobInvalidation, eq(jobInvalidation.key, job.key))
                  .where(
                    and(
                      eq(job.kind, "ai.evaluation"),
                      jobDue(new Date()),
                      sql`${jobRunOwned()}=${anchor?.owned ?? false}`,
                      predicate,
                    ),
                  )
                  .orderBy(desc(job.priority), job.updatedAt, job.id)
                  .limit(100)
                  .for("update", { of: job, skipLocked: true });
                const result = await getDb(ctx.db).execute(
                  sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.getSQL()}`,
                );
                plans.push({ name, rows: result.rows });
              }
              await writeFile(
                resolve(output, `claim-plans-${count}.json`),
                JSON.stringify(plans, null, 2),
              );
            };

            const started = performance.now();
            let peakOtherActiveClients = 0;
            const sampleActivity = async () => {
              const result = await getDb(ctx.db).execute<{ other: number }>(
                sql`SELECT count(*)::int AS other FROM pg_stat_activity WHERE state=${"active"} AND backend_type='client backend' AND datname<>current_database()`,
              );
              peakOtherActiveClients = Math.max(
                peakOtherActiveClients,
                result.rows[0]?.other ?? 0,
              );
            };
            await sampleActivity();

            const cpu = process.cpuUsage();
            let peakJobErrors = 0,
              expiredAtPageBoundary = 0;
            const evaluationHandler = {
              ...aiEvaluationJobHandler,
              advancePage: async (db: Database, id: string) => {
                const result = await aiEvaluationJobHandler.advancePage(db, id);
                const [sample] = await getDb(db)
                  .select({
                    errors: sql<number>`count(*) FILTER (WHERE ${job.error} IS NOT NULL)::int`,
                    expired: sql<number>`count(*) FILTER (WHERE ${job.state}=${aiEvaluationState.enum.running} AND ${job.leaseExpiresAt}<=now())::int`,
                  })
                  .from(job)
                  .where(eq(job.kind, "ai.evaluation"));
                peakJobErrors = Math.max(peakJobErrors, sample?.errors ?? 0);
                expiredAtPageBoundary = Math.max(
                  expiredAtPageBoundary,
                  sample?.expired ?? 0,
                );
                return result;
              },
            };

            const discoveredRuns = new Set<string>();
            let discoveryStatements = 0,
              executionStatements = 0,
              pageServices = 0;
            const statementFamilies = new Map<string, number>();
            const observe = (statements: readonly string[]) => {
              for (const statement of statements) {
                const family = statement.slice(0, 200);
                statementFamilies.set(
                  family,
                  (statementFamilies.get(family) ?? 0) + 1,
                );
              }
            };
            for (let page = 0; page <= Math.ceil(count / 200); page++) {
              const measured = await countTestDbQueries(() =>
                discoverAiRefresh(ctx.db, { context: kernelCtx(ctx) }),
              );
              discoveryStatements += measured.queryCount;
              observe(measured.statements);
              for (const id of measured.result.runs) discoveredRuns.add(id);
              if (measured.result.complete) break;
            }
            await writeFile(
              resolve(output, `progress-${count}.json`),
              JSON.stringify({
                phase: "discovered",
                runs: [...discoveredRuns],
                discoveryStatements,
              }),
            );
            if (
              process.env.CUBBY_PAGE_CLAIM_PLANS === "1" &&
              cacheState === "cold"
            ) {
              const began = performance.now();
              await planPair();
              planMs = performance.now() - began;
            }
            const discoveryMs = performance.now() - started - planMs;
            const runIds = [...discoveredRuns].map((id) =>
              parseEntityId("run", id),
            );
            expect(runIds.length).toBeGreaterThan(0);
            let stopped = false;
            while (
              performance.now() - started <
              (count < 500 ? 60_000 : 15 * 60_000)
            ) {
              const measured = await countTestDbQueries(() =>
                drainDueJobs(
                  ctx.db,
                  {
                    "ai.evaluation": evaluationHandler,
                    "run.execute": runJobHandler,
                  },
                  256,
                  20_000,
                  3,
                ),
              );
              await sampleActivity();
              executionStatements += measured.queryCount;
              pageServices += measured.result.length;
              observe(measured.statements);
              const owners = await getDb(ctx.db)
                .select({ status: run.status })
                .from(run)
                .where(inArray(run.id, runIds));
              const pending = await getDb(ctx.db)
                .select({
                  state: aiEvaluation.state,
                  count: sql<number>`count(*)::int`,
                })
                .from(aiEvaluation)
                .where(inArray(aiEvaluation.runId, runIds))
                .groupBy(aiEvaluation.state);
              const jobStates = await getDb(ctx.db)
                .select({
                  kind: job.kind,
                  state: job.state,
                  error: job.error,
                  count: sql<number>`count(*)::int`,
                })
                .from(job)
                .groupBy(job.kind, job.state, job.error);
              await writeFile(
                resolve(output, `progress-${count}.json`),
                JSON.stringify({
                  phase: "draining",
                  elapsedMs: performance.now() - started,
                  owners,
                  pending,
                  jobStates,
                  pageServices,
                  outcomes: measured.result,
                  requests: calls.length,
                }),
              );
              if (owners.every((owner) => owner.status !== "running")) {
                stopped = true;
                break;
              }
              if (!measured.result.length)
                await new Promise<void>((resolve) => setTimeout(resolve, 25));
            }
            const elapsedMs = performance.now() - started - planMs;
            const states = await getDb(ctx.db)
              .select({
                state: aiEvaluation.state,
                kind: sql<string>`${aiEvaluation.target}->>${"kind"}`,
                count: sql<number>`count(*)::int`,
              })
              .from(aiEvaluation)
              .where(inArray(aiEvaluation.runId, runIds))
              .groupBy(sql`1`, sql`2`);
            const owners = await getDb(ctx.db)
              .select({ status: run.status, progress: run.progress })
              .from(run)
              .where(inArray(run.id, runIds));
            const receipts = await getDb(ctx.db)
              .select({ count: sql<number>`count(*)::int` })
              .from(aiEvaluationRequest)
              .where(
                and(
                  inArray(aiEvaluationRequest.runId, runIds),
                  sql`${aiEvaluationRequest.receipt} IS NOT NULL`,
                ),
              );
            const assessments = await getDb(ctx.db)
              .select({ count: sql<number>`count(*)::int` })
              .from(assessment)
              .where(eq(assessment.family, assessmentFamily.enum.product_pair));
            const activePairs = await getDb(ctx.db)
              .select({ count: sql<number>`count(*)::int` })
              .from(assessmentState)
              .where(
                and(
                  eq(
                    assessmentState.family,
                    assessmentFamily.enum.product_pair,
                  ),
                  eq(assessmentState.active, true),
                  sql`${assessmentState.data}->>'otherId' IS NOT NULL`,
                ),
              );
            const leases = await getDb(ctx.db).execute<{
              expired: number;
              retries: number;
              sockets: number;
            }>(sql`SELECT
          (SELECT count(*)::int FROM "Job" WHERE kind='ai.evaluation' AND state=${aiEvaluationState.enum.running} AND "leaseExpiresAt"<=now()) AS expired,
          (SELECT count(*)::int FROM "Job" WHERE kind='ai.evaluation' AND error IS NOT NULL) AS retries,
          (SELECT count(*)::int FROM pg_stat_activity WHERE datname=current_database()) AS sockets`);
            const observations = {
              cacheState,
              elapsedMs,
              discoveryMs,
              planMs,
              discoveryStatements,
              executionStatements,
              pageServices,
              peakOtherActiveClients,
              peakJobErrors,
              expiredAtPageBoundary,
              states,
              owners,
              receipts: receipts[0]?.count,
              assessments: assessments[0]?.count,
              activePairs: activePairs[0]?.count,
              leases: leases.rows,
              calls: calls.slice(firstCall),
              cpu: process.cpuUsage(cpu),
              statementFamilies: [...statementFamilies],
            };
            cycles.push(observations);
            await writeFile(
              resolve(output, `full-${count}-${routing}-${latency}.json`),
              JSON.stringify(
                {
                  seed: "synthetic-page-group-v1",
                  products: count,
                  degree: 4,
                  expectedCanonicalPairs: count * 2,
                  setupMs,
                  node: process.version,
                  platform: process.platform,
                  arch: process.arch,
                  cacheBackend:
                    "real Node response-cache fallback; capacity 512 entries",
                  peakHeap,
                  peakRequests,
                  cycles,
                },
                null,
                2,
              ),
            );
            expect(stopped).toBe(true);
            expect(owners.every((owner) => owner.status === "completed")).toBe(
              true,
            );
            expect(
              states.filter((entry) => entry.state !== "completed"),
            ).toEqual([]);
            expect(states.reduce((sum, entry) => sum + entry.count, 0)).toBe(
              cacheState === "skew" ? Math.min(count, 130) : count * 3,
            );
            expect(receipts[0]?.count).toBe(
              cacheState === "skew" ? Math.min(count, 130) - 1 : count * 2,
            );
            expect(activePairs[0]?.count).toBe(
              count * 2 +
                (cacheState === "skew" ? Math.min(count, 130) - 5 : 0),
            );
            expect(leases.rows[0]?.expired).toBe(0);
            expect(leases.rows[0]?.retries).toBe(0);
            expect(peakJobErrors).toBe(0);
            expect(expiredAtPageBoundary).toBe(0);
          }
        } finally {
          clearInterval(memory);
        }
      },
      2_400_000,
    );
  },
);
