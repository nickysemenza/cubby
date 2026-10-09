import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { userId } from "@cubby/schemas/identifiers";
import type { PurchaseAgentEvent } from "@cubby/schemas/purchase-import";
import { and, eq } from "drizzle-orm";
import {
  type EvalUsage,
  evalCandidates,
  evalCostUsd,
  evalUsageReport,
  evalWebRoot,
  subscriptionEvalModelWorker,
  evalSubscriptionOutputTokens,
} from "tooling/ai/eval-support";
import {
  captureE2ERunIdentity,
  writeE2ERunBundle,
  type E2ERunIdentity,
} from "tooling/e2e-run-bundle";
import { startLocalChatGptProvider } from "tooling/local-chatgpt-provider";
import type { ResearchEvalPeerConfiguration } from "tooling/research-eval-peer";
import { withTestDb } from "tooling/test-setup";
import { readWebBuildProvenance } from "tooling/web-build-provenance";
import { withWorkerdRuntime } from "tooling/workerd-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { scrubErrorMessage } from "~/lib/error-diagnostics";
import type { Database } from "~/server/db";
import {
  entityAttachment,
  entityExternalId,
  product,
  run,
  runEvidence,
  runFactEvidence,
  runOperation,
  runProgress,
  runTarget,
} from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";

import { loadCurrentFactEvidence } from "./fact-verification";
import { startProductResearch } from "./product-research-run";
import {
  authorizePurchaseAgent,
  workerdDiagnostic,
} from "./purchase-agent-workerd.fixtures";
import {
  researchEvalCases,
  canonicalFailures,
  retainedSourceFailures,
  prepareResearchEvalFixture,
  waitForResearchEvalSettlement,
  type ResearchEvalCase,
} from "./purchase-research-eval.fixtures";
import {
  loadProductResearchCoverage,
  readResearchCanonicalProjection,
} from "./research-projection";

// No semantic answers are injected: the real researcher chooses mounted tools,
// retains source bytes, and submits claims to the real source-support validator.
const candidates = evalCandidates("gpt-6-sol:high");
const selected = process.env.PURCHASE_EVAL_CASES?.split(",") ?? [
  "ordinary-product",
  "selected-variant-no-jsonld",
];
const cases = researchEvalCases.filter((entry) =>
  selected.includes(entry.name),
);
if (cases.length !== selected.length)
  throw new Error("Unknown or repeated research evaluation case");
const runCount = cases.length * candidates.length;
const caseTimeoutMs = 8 * 60_000;
const aggregate = {
  requests: z.coerce
    .number()
    .int()
    .min(runCount * 3)
    .max(112)
    .parse(process.env.AGENT_EVAL_MAX_REQUESTS ?? 24),
  tokens: z.coerce
    .number()
    .int()
    .min(runCount * 12_000)
    .max(2_816_000)
    .parse(process.env.AGENT_EVAL_MAX_TOKENS ?? 256_000),
  outputTokens: 4_000,
};
const limitsFor = async (
  role: "researcher" | "assessor",
  model: (typeof candidates)[number]["model"],
) => ({
  maxModelOutputTokens: await evalSubscriptionOutputTokens(model),
  requests: Math.floor(
    (aggregate.requests * (role === "researcher" ? 2 / 3 : 1 / 3)) / runCount,
  ),
  tokens: Math.floor(
    (aggregate.tokens * (role === "researcher" ? 3 / 4 : 1 / 4)) / runCount,
  ),
  outputTokens: aggregate.outputTokens,
  wallMs: caseTimeoutMs,
});
const budgetReport = z.object({
  requests: z.number(),
  reservedTokens: z.number(),
  refusedRequests: z.number(),
  wallLimitMs: z.number(),
  remainingWallMs: z.number(),
  largestRequestBytes: z.number(),
  largestReservation: z.number(),
  lastRefusedReservation: z.number().nullable(),
});
const settled = new Set([
  "completed",
  "needs_review",
  "failed",
  "cancelled",
  "client_update_required",
  "dispatch_failed",
]);
const repoRoot = path.resolve(evalWebRoot, "../..");
const replayCommand = `AGENT_EVAL_CANDIDATES='${candidates.map((entry) => `${entry.model}:${entry.effort}`).join(",")}' PURCHASE_EVAL_CASES='${cases.map((entry) => entry.name).join(",")}' AGENT_EVAL_MAX_REQUESTS=${aggregate.requests} AGENT_EVAL_MAX_TOKENS=${aggregate.tokens} pnpm --dir ${evalWebRoot} eval:purchase-decisions`;

async function prepareEvalPreflight(
  db: Database,
  actor: Parameters<typeof prepareResearchEvalFixture>[1],
  candidate: (typeof candidates)[number],
  scenario: ResearchEvalCase,
) {
  const fixture = await prepareResearchEvalFixture(db, actor, scenario);
  const [baseline] = await getDb(db)
    .select()
    .from(product)
    .where(eq(product.id, fixture.item.entityId));
  if (!baseline) throw new Error("Synthetic canonical baseline missing");
  const events: PurchaseAgentEvent[] = [];
  const [admission] = await startProductResearch(
    db,
    {
      ledgerPartyId: fixture.party.id,
      userId: userId.parse(actor.userId),
      productIds: [fixture.item.entityId],
      cause: "member_request",
    },
    {
      send: async (event) => {
        events.push(event);
      },
    },
  );
  if (!admission || events.length !== 1 || !events[0])
    throw new Error("Synthetic research Run was not admitted exactly once");
  return {
    candidate,
    scenario,
    fixture,
    baseline,
    admission,
    event: events[0],
  };
}

function provenanceFailures(
  scenario: ResearchEvalCase,
  proofs: (typeof runFactEvidence.$inferSelect)[],
  supportedPaths: Set<string>,
  identifiers: (typeof entityExternalId.$inferSelect)[],
  target: typeof runTarget.$inferSelect | undefined,
) {
  const failures: string[] = [];
  if (
    proofs.some((proof) =>
      proof.fieldPath === "manufacturer"
        ? proof.value !== "Example Works"
        : proof.fieldPath === "model"
          ? !scenario.expectedModel || proof.value !== scenario.expectedModel
          : !proof.fieldPath.startsWith("externalIds.") ||
            !scenario.expectedSku,
    )
  )
    failures.push("Unsupported retained fact proof");
  if (
    !scenario.ambiguous &&
    (!supportedPaths.has("manufacturer") || !supportedPaths.has("model"))
  )
    failures.push("Positive result lacked current manufacturer/model proof");
  if (
    scenario.expectedSku &&
    (!identifiers.length ||
      ![...supportedPaths].some((path) => path.startsWith("externalIds.")))
  )
    failures.push("Visible selected SKU lacked current member proof");
  if (
    scenario.ambiguous &&
    (!target ||
      !["ambiguous", "researched_with_gaps", "partially_verified"].includes(
        target.outcome ?? "",
      ))
  )
    failures.push("Genuine ambiguity was not left honestly unresolved");
  if (!scenario.ambiguous && target?.outcome === "verified")
    failures.push("Missing image/category coverage was reported verified");
  return failures;
}

function coverageFailures(
  scenario: ResearchEvalCase,
  coverage: Awaited<ReturnType<typeof loadProductResearchCoverage>>,
  target: typeof runTarget.$inferSelect | undefined,
) {
  const failures: string[] = [];
  if (
    coverage.complete ||
    JSON.stringify([...coverage.missingFields].sort()) !==
      JSON.stringify([...scenario.expectedMissingFields].sort())
  )
    failures.push("Current proof coverage did not match the fixed source gaps");
  if (
    target?.state !== "unresolved" ||
    (!scenario.ambiguous &&
      !["researched_with_gaps", "partially_verified"].includes(
        target.outcome ?? "",
      ))
  )
    failures.push(
      "Incomplete research did not preserve an honest unresolved target",
    );
  return failures;
}

function executionMetrics(
  status: string,
  header: Pick<typeof run.$inferSelect, "status" | "endedAt"> | undefined,
  target: typeof runTarget.$inferSelect | undefined,
  coverage: Awaited<ReturnType<typeof loadProductResearchCoverage>>,
) {
  return {
    outcome: target?.outcome,
    targetState: target?.state,
    endedAt: header?.endedAt,
    executionSettled: Boolean(header?.endedAt && settled.has(status)),
    honestGapSettlement: status === "needs_review" && Boolean(header?.endedAt),
    fullyVerified:
      coverage.complete &&
      target?.outcome === "verified" &&
      target.state === "completed" &&
      status === "completed",
    interventionCount: Number(status === "awaiting_approval"),
  };
}

async function waitForSettlement(
  db: Database,
  runId: typeof run.$inferSelect.id,
  begin: number,
  readBudgets: () => Promise<z.infer<typeof budgetReport>[]>,
) {
  return waitForResearchEvalSettlement({
    begin,
    timeoutMs: caseTimeoutMs,
    readBudgets,
    readState: async () => {
      const [header] = await getDb(db)
        .select()
        .from(run)
        .where(eq(run.id, runId));
      const [approval] = await getDb(db)
        .select()
        .from(runProgress)
        .where(
          and(
            eq(runProgress.runId, runId),
            eq(runProgress.awaitingApproval, true),
          ),
        );
      if (approval) return "awaiting_approval";
      return header && settled.has(header.status) ? header.status : null;
    },
  });
}

function usageFailures(usage: EvalUsage, budget: z.infer<typeof budgetReport>) {
  const failures: string[] = [];
  if (budget.refusedRequests || usage.failedRequests)
    failures.push("Inference failed or exhausted its bounded allowance");
  if (!usage.requests || usage.calls.length !== usage.requests)
    failures.push("Live researcher/support inference usage was incomplete");
  if (usage.inputTokens + usage.outputTokens > budget.reservedTokens)
    failures.push("Reported token usage exceeded its conservative reservation");
  return failures;
}

describe("bounded real Product researcher evaluation", () => {
  const ctx = withTestDb();
  it(
    "investigates fixed sources through mounted tools and retains supported current facts",
    async () => {
      const outDir = path.join(
        repoRoot,
        "artifacts/purchase-research-eval",
        new Date().toISOString().replace(/[:.]/gu, "-"),
      );
      mkdirSync(outDir, { recursive: true });
      const revision = {
        head: execFileSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], {
          encoding: "utf8",
        }).trim(),
        fixtureSha256: createHash("sha256")
          .update(JSON.stringify(researchEvalCases))
          .digest("hex"),
        evaluatorSha256: createHash("sha256")
          .update(
            readFileSync(
              path.join(
                evalWebRoot,
                "src/server/purchase-import/purchase-decision-eval.live-eval.ts",
              ),
            ),
          )
          .digest("hex"),
        fixtureFactorySha256: createHash("sha256")
          .update(
            readFileSync(
              path.join(
                evalWebRoot,
                "src/server/purchase-import/purchase-research-eval.fixtures.ts",
              ),
            ),
          )
          .digest("hex"),
        sharedFixtureSha256: createHash("sha256")
          .update(
            readFileSync(
              path.join(
                evalWebRoot,
                "src/server/purchase-import/product-research.fixtures.ts",
              ),
            ),
          )
          .digest("hex"),
        peerSha256: createHash("sha256")
          .update(
            readFileSync(
              path.join(evalWebRoot, "tooling/research-eval-peer.ts"),
            ),
          )
          .digest("hex"),
      };
      const results: object[] = [];
      const caseResults: NonNullable<
        Parameters<typeof writeE2ERunBundle>[0]["cases"]
      > = [];
      const allFailures: string[] = [];
      let started: E2ERunIdentity | undefined;
      let status = "failed";
      let phase = "setup";
      let failure: string | undefined;
      let activeCase: ResearchEvalCase | undefined;
      let activeCandidate: (typeof candidates)[number] | undefined;
      let activeRunId: typeof run.$inferSelect.id | undefined;
      let activeCaseName: string | undefined;
      let caseBegin = 0;
      let inferenceAtExit: object | undefined;
      let subscription:
        | Awaited<ReturnType<typeof startLocalChatGptProvider>>
        | undefined;
      let executionsSettled = 0;
      let fullyVerified = 0;
      let acceptedCases = 0;
      const reportPath = path.join(outDir, "report.json");
      const buildPath = path.join(outDir, "build.json");
      const writeReport = () =>
        writeFileSync(
          reportPath,
          `${JSON.stringify({ synthetic: true, status, phase, failure, revision, replayCommand, aggregate, caseWallMs: caseTimeoutMs, transport: "chatgpt", separatelyBilledApiCostUsd: 0, budgetMethod: "Per-role/per-case UTF-8 request-byte plus live catalog maximum-output reservations and propagated wall deadline; subscription strips requested output caps; reported token usage recorded separately", modelSnapshotPinned: false, assessor: "gpt-6-sol:high", executionsSettled, fullyVerified, acceptedCases, results, inferenceAtExit }, null, 2)}\n`,
        );
      writeReport();
      try {
        await authorizePurchaseAgent(ctx.db, ctx.actor.userId);
        // Admission must finish for every case before the first billable dispatch.
        const preflights: Awaited<ReturnType<typeof prepareEvalPreflight>>[] =
          [];
        for (const candidate of candidates)
          for (const scenario of cases)
            preflights.push(
              await prepareEvalPreflight(
                ctx.db,
                ctx.actor,
                candidate,
                scenario,
              ),
            );
        subscription = await startLocalChatGptProvider();
        const peer = subscriptionEvalModelWorker(subscription.origin);
        const peerFor = (role: "researcher" | "assessor") => ({
          ...peer,
          main: "tooling/research-eval-peer.ts",
          vars: { ...peer.vars, ROLE: role },
        });
        await withWorkerdRuntime(
          {
            profile: "purchase-agent",
            database: { borrowed: ctx.databaseUrl },
            objectStorage: {},
            models: {
              agent: peerFor("researcher"),
              gateway: peerFor("assessor"),
            },
          },
          async (runtime) => {
            const build = readWebBuildProvenance(repoRoot);
            writeFileSync(buildPath, `${JSON.stringify(build, null, 2)}\n`);
            if (!build.sourceFresh)
              throw new Error(
                `Research eval build is stale: ${build.details.reason}`,
              );
            started = captureE2ERunIdentity(repoRoot);
            phase = "research";
            const researcher = runtime.harness.getWorker("cubby-test-model");
            const assessor = runtime.harness.getWorker("cubby-test-gateway");
            const queue = runtime.harness.getWorker("cubby-queue-producer");
            const configure = async (
              worker: typeof researcher,
              body: ResearchEvalPeerConfiguration,
            ) => {
              const response = await worker.fetch(
                "https://eval.test/configure",
                {
                  method: "POST",
                  body: JSON.stringify(body),
                },
              );
              if (!response.ok) throw new Error(await response.text());
            };
            try {
              for (const {
                candidate,
                scenario,
                fixture,
                baseline,
                admission: started,
                event,
              } of preflights) {
                activeCaseName = `${candidate.model}:${candidate.effort}/${scenario.name}`;
                caseBegin = Date.now();
                await configure(researcher, {
                  ...candidate,
                  limits: await limitsFor("researcher", candidate.model),
                  sources: [],
                });
                await configure(assessor, {
                  model: "gpt-6-sol",
                  effort: "high",
                  limits: await limitsFor("assessor", "gpt-6-sol"),
                  sources: [...scenario.pages],
                });
                activeCase = scenario;
                activeCandidate = candidate;
                activeRunId = started.runId;
                const begin = Date.now();
                const dispatched = await queue.fetch(
                  "https://queue.test/dispatch",
                  { method: "POST", body: JSON.stringify(event) },
                );
                if (!dispatched.ok) throw new Error(await dispatched.text());
                const status = await waitForSettlement(
                  ctx.db,
                  started.runId,
                  begin,
                  async () =>
                    Promise.all(
                      [researcher, assessor].map(async (peer) =>
                        budgetReport.parse(
                          await (
                            await peer.fetch("https://eval.test/budget")
                          ).json(),
                        ),
                      ),
                    ),
                );
                const wallMs = Date.now() - begin;
                const [current] = await getDb(ctx.db)
                  .select()
                  .from(product)
                  .where(eq(product.id, fixture.item.entityId));
                const [target] = await getDb(ctx.db)
                  .select()
                  .from(runTarget)
                  .where(eq(runTarget.runId, started.runId));
                const [settledRun] = await getDb(ctx.db)
                  .select({ status: run.status, endedAt: run.endedAt })
                  .from(run)
                  .where(eq(run.id, started.runId));
                const proofs = target
                  ? await getDb(ctx.db)
                      .select()
                      .from(runFactEvidence)
                      .where(eq(runFactEvidence.targetId, target.id))
                  : [];
                const evidence = await getDb(ctx.db)
                  .select()
                  .from(runEvidence)
                  .where(eq(runEvidence.runId, started.runId));
                const operations = await getDb(ctx.db)
                  .select()
                  .from(runOperation)
                  .where(eq(runOperation.runId, started.runId));
                const identifiers = await getDb(ctx.db)
                  .select()
                  .from(entityExternalId)
                  .where(
                    and(
                      eq(entityExternalId.entityKind, "product"),
                      eq(entityExternalId.entityId, fixture.item.entityId),
                    ),
                  );
                const images = await getDb(ctx.db)
                  .select()
                  .from(entityAttachment)
                  .where(eq(entityAttachment.entityId, fixture.item.entityId));
                const currentProofs = (
                  await Promise.all(
                    ["manufacturer", "model", "externalIds"].map((fieldPath) =>
                      loadCurrentFactEvidence(
                        ctx.db,
                        {
                          entityKind: "product",
                          entityId: fixture.item.id,
                          fieldPath,
                          ledgerPartyId: fixture.party.id,
                        },
                        readResearchCanonicalProjection,
                      ),
                    ),
                  )
                ).flat();
                const supportedPaths = new Set(
                  currentProofs
                    .filter(
                      (proof) =>
                        proof.support !== null &&
                        proof.supportRetiredAt === null,
                    )
                    .map((proof) => proof.fieldPath),
                );
                const coverage = await loadProductResearchCoverage(ctx.db, {
                  productId: fixture.item.entityId,
                  ledgerPartyId: fixture.party.id,
                });
                const failures = [
                  ...canonicalFailures(
                    scenario,
                    current,
                    identifiers,
                    images,
                    baseline,
                  ),
                  ...provenanceFailures(
                    scenario,
                    proofs,
                    supportedPaths,
                    identifiers,
                    target,
                  ),
                  ...coverageFailures(scenario, coverage, target),
                ];
                const metrics = executionMetrics(
                  status,
                  settledRun,
                  target,
                  coverage,
                );
                if (!metrics.honestGapSettlement)
                  failures.push(
                    `Incomplete research did not settle honestly: ${status}`,
                  );
                failures.push(
                  ...(await retainedSourceFailures(
                    evidence,
                    scenario,
                    runtime.objectStorageUrl,
                    fixture.mail,
                  )),
                );
                const researcherUsage = evalUsageReport.parse(
                  await (
                    await researcher.fetch("https://eval.test/usage")
                  ).json(),
                );
                const assessorUsage = evalUsageReport.parse(
                  await (
                    await assessor.fetch("https://eval.test/usage")
                  ).json(),
                );
                const researcherBudget = budgetReport.parse(
                  await (
                    await researcher.fetch("https://eval.test/budget")
                  ).json(),
                );
                const assessorBudget = budgetReport.parse(
                  await (
                    await assessor.fetch("https://eval.test/budget")
                  ).json(),
                );
                failures.push(
                  ...usageFailures(researcherUsage, researcherBudget),
                  ...usageFailures(assessorUsage, assessorBudget),
                );
                const researcherCost = await evalCostUsd(
                  candidate.model,
                  researcherUsage,
                );
                const assessorCost = await evalCostUsd(
                  "gpt-6-sol",
                  assessorUsage,
                );
                executionsSettled += Number(metrics.executionSettled);
                fullyVerified += Number(metrics.fullyVerified);
                acceptedCases += Number(!failures.length);
                results.push({
                  case: scenario.name,
                  candidate,
                  status,
                  ...metrics,
                  verifiedFields: coverage.verifiedFields,
                  missingFields: coverage.missingFields,
                  wallMs,
                  supportedPaths: [...supportedPaths],
                  acceptedFactCount: supportedPaths.size,
                  toolCalls: operations.filter((operation) =>
                    operation.kind.startsWith("research_"),
                  ).length,
                  failures,
                  researcherUsage,
                  assessorUsage,
                  researcherBudget,
                  assessorBudget,
                  costUsd:
                    researcherCost === null || assessorCost === null
                      ? null
                      : researcherCost + assessorCost,
                  operations,
                  proofs,
                  evidence,
                  current,
                  identifiers,
                });
                caseResults.push({
                  name: activeCaseName,
                  status: failures.length ? "failed" : "passed",
                  durationMs: Date.now() - caseBegin,
                });
                allFailures.push(
                  ...failures.map((message) => `${activeCaseName}: ${message}`),
                );
                writeReport();
                if (!metrics.executionSettled)
                  throw new Error(
                    `Research evaluation stopped at ${status}; remaining pre-admitted cases were not dispatched`,
                  );
              }
              expect(results).toHaveLength(runCount);
              expect(
                allFailures,
                `Synthetic researcher report ${outDir}`,
              ).toEqual([]);
            } finally {
              const snapshots = await Promise.allSettled([
                researcher
                  .fetch("https://eval.test/usage")
                  .then((response) => response.json()),
                assessor
                  .fetch("https://eval.test/usage")
                  .then((response) => response.json()),
                researcher
                  .fetch("https://eval.test/budget")
                  .then((response) => response.json()),
                assessor
                  .fetch("https://eval.test/budget")
                  .then((response) => response.json()),
                activeRunId
                  ? workerdDiagnostic(ctx.db, activeRunId, runtime.harness)
                  : Promise.resolve(null),
              ]);
              inferenceAtExit = {
                case: activeCase?.name,
                candidate: activeCandidate,
                runId: activeRunId,
                snapshots: snapshots.map((snapshot, index) => ({
                  boundary: [
                    "researcher usage",
                    "assessor usage",
                    "researcher budget",
                    "assessor budget",
                    "run diagnostics",
                  ][index],
                  ...(snapshot.status === "fulfilled"
                    ? { status: snapshot.status, value: snapshot.value }
                    : {
                        status: snapshot.status,
                        failure: scrubErrorMessage(String(snapshot.reason)),
                      }),
                })),
              };
              writeReport();
            }
          },
        );
        status = "passed";
        phase = "complete";
      } catch (error) {
        failure = scrubErrorMessage(
          error instanceof Error ? error.message : String(error),
        );
        if (
          activeCaseName &&
          !caseResults.some((entry) => entry.name === activeCaseName)
        )
          caseResults.push({
            name: activeCaseName,
            status: "failed",
            durationMs: Date.now() - caseBegin,
          });
        throw error;
      } finally {
        await subscription?.close();
        writeReport();
        writeE2ERunBundle({
          repoRoot,
          outputDir: outDir,
          evidence: [reportPath, ...(existsSync(buildPath) ? [buildPath] : [])],
          kind: "browser",
          status,
          phase,
          command: [
            "env",
            `AGENT_EVAL_CANDIDATES=${candidates.map((entry) => `${entry.model}:${entry.effort}`).join(",")}`,
            `PURCHASE_EVAL_CASES=${cases.map((entry) => entry.name).join(",")}`,
            `AGENT_EVAL_MAX_REQUESTS=${aggregate.requests}`,
            `AGENT_EVAL_MAX_TOKENS=${aggregate.tokens}`,
            "pnpm",
            "--dir",
            "apps/web",
            "eval:purchase-decisions",
          ],
          profile: "purchase-agent",
          scenario: "synthetic-real-product-researcher",
          started,
          build: readWebBuildProvenance(repoRoot),
          cases: caseResults,
        });
      }
    },
    runCount * (caseTimeoutMs + 30_000) + 120_000,
  );
});
