import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { runEntityId, parseEntityId } from "@cubby/schemas/identifiers";
import { sleep } from "@cubby/shared/retry";
import { and, eq, inArray } from "drizzle-orm";
import {
  type EvalCandidate,
  evalCandidates,
  evalCostUsd,
  evalUsageReport,
  evalWebRoot,
  liveEvalModelWorker,
  meanEvalCostUsd,
} from "tooling/ai/eval-support";
import { withTestDb } from "tooling/test-setup";
import { withWorkerdRuntime } from "tooling/workerd-runtime";
import { describe, expect, it } from "vitest";

import {
  aiAnalysis,
  run as runTable,
  runProgress,
  runTarget,
  oauthRefreshToken,
  photoGroupProposal,
  session,
} from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import {
  createImageFixture,
  createProductFixture,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import {
  ensurePurchaseAgentOAuthClient,
  PURCHASE_AGENT_OAUTH_CLIENT_ID,
} from "./agent-auth";
import {
  type EvalCase,
  agentModelEvalCases,
} from "./agent-model-eval.fixtures";
import { scoreProposals } from "./agent-model-eval.score";
import {
  startPhotoInventoryCoordinator,
  startPhotoInventoryRun,
} from "./run-service";

/**
 * Live photo-coordinator model comparison. Opt-in and billed: it runs the real
 * import-run agent in workerd against an isolated database, with its model calls
 * forwarded to Cubby's AI Gateway as each candidate. Run with
 * `pnpm --dir apps/web eval:agent-models`.
 */
const candidates = evalCandidates(
  "gpt-6-luna:medium,gpt-6-luna:high,gpt-6-sol:medium,gpt-6-sol:high",
);
const caseFilter = process.env.AGENT_EVAL_CASES?.split(",");
const cases = agentModelEvalCases.filter(
  (evalCase) => !caseFilter || caseFilter.includes(evalCase.name),
);
const repeats = Number(process.env.AGENT_EVAL_REPEATS ?? "1");
const RUN_TIMEOUT_MS = 8 * 60_000;

async function poll(done: () => Promise<boolean>) {
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await done()) return true;
    await sleep(1_000);
  }
  return false;
}

describe("photo coordinator model eval", () => {
  const ctx = withTestDb();

  it(
    "compares candidate models on synthetic photo runs",
    async () => {
      await insertWithShortcode(ctx.db, "ledgerParty", {
        name: "Synthetic eval member",
        kind: "member",
        userId: ctx.actor.userId,
      });
      await ensurePurchaseAgentOAuthClient(ctx.db);
      const now = new Date();
      const sessionId = `agent-eval-${crypto.randomUUID()}`;
      await getDb(ctx.db)
        .insert(session)
        .values({
          id: sessionId,
          token: `${sessionId}-token`,
          userId: ctx.actor.userId,
          expiresAt: new Date(now.getTime() + 6 * 60 * 60_000),
          createdAt: now,
          updatedAt: now,
        });
      await getDb(ctx.db)
        .insert(oauthRefreshToken)
        .values({
          id: `${sessionId}-grant`,
          token: `${sessionId}-refresh`,
          clientId: PURCHASE_AGENT_OAUTH_CLIENT_ID,
          sessionId,
          userId: ctx.actor.userId,
          expiresAt: new Date(now.getTime() + 6 * 60 * 60_000),
          createdAt: now,
          authTime: now,
          scopes: ["openid", "profile", "email", "offline_access"],
        });

      // Closes workerd, the database environment and the harness lock even
      // when a case or the report fails, before Vitest releases the database.
      await withWorkerdRuntime(
        {
          profile: "purchase-agent",
          database: { borrowed: ctx.databaseUrl },
          models: { agent: liveEvalModelWorker() },
        },
        async ({ harness }) => {
          // The web Worker is the harness's primary Worker, so `listen()`'s URL
          // serves the app; the agent queue is reached through its producer.
          const queue = harness.getWorker("cubby-queue-producer");
          const model = harness.getWorker("cubby-test-model");

          // Catalog Products are created once and shared by every candidate:
          // proposals are never approved, so no run changes them.
          const catalog = new Map<string, string>();
          const runCase = async (evalCase: EvalCase, choice: EvalCandidate) => {
            const products = new Map<string, string>();
            for (const entry of evalCase.catalog) {
              let productId = catalog.get(entry.key);
              if (!productId) {
                productId = (
                  await createProductFixture(
                    ctx.db,
                    makeProductInput({
                      name: entry.name,
                      manufacturer: entry.manufacturer,
                    }),
                    ctx.actor,
                  )
                ).entityId;
                catalog.set(entry.key, productId);
              }
              products.set(productId, entry.key);
            }
            const run = await startPhotoInventoryRun(ctx.db, {
              actorUserId: ctx.actor.userId,
            });
            const photoKeys = new Map<string, string>();
            for (const [position, photo] of evalCase.photos.entries()) {
              const fixture = await createImageFixture(
                ctx.db,
                `eval-${evalCase.name}-${photo.key}-${crypto.randomUUID()}`,
              );
              photoKeys.set(fixture.id, photo.key);
              await getDb(ctx.db)
                .insert(aiAnalysis)
                .values({
                  entityKind: "image",
                  entityId: fixture.id,
                  feature: "image-description",
                  model: "synthetic",
                  promptVersion: "eval",
                  inputFingerprint: `eval-${photo.key}`,
                  result: {
                    description: photo.labelText
                      ? `${photo.description} Readable text: "${photo.labelText}".`
                      : photo.description,
                    cutoutEligibility: "eligible",
                    claims: photo.labelText
                      ? [{ text: photo.labelText, evidenceKind: "label" }]
                      : [],
                  },
                });
              await getDb(ctx.db)
                .insert(runTarget)
                .values({
                  runId: runEntityId.parse(run.id),
                  entityKind: "image",
                  entityId: parseEntityId("image", fixture.id),
                  position,
                  state: "pending",
                  targetFingerprint: `eval-${crypto.randomUUID()}`,
                });
            }
            const started = await startPhotoInventoryCoordinator(ctx.db, {
              publicId: run.publicId,
              actorUserId: ctx.actor.userId,
            });
            await model.fetch("https://model.test/configure", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(choice),
            });
            const startedAt = Date.now();
            const dispatched = await queue.fetch(
              "https://queue.test/dispatch",
              {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  version: 1,
                  type: "start_or_resume",
                  runId: run.id,
                  purpose: "photo_inventory",
                  eventId: started.eventId,
                }),
              },
            );
            if (!dispatched.ok)
              throw new Error(
                `Dispatch failed (${dispatched.status}): ${await dispatched.text()}`,
              );
            const runId = runEntityId.parse(run.id);
            const settled = await poll(async () => {
              const [row] = await getDb(ctx.db)
                .select({ status: runTable.status })
                .from(runTable)
                .where(eq(runTable.id, runId));
              if (row && row.status !== "running") return true;
              const waiting = await getDb(ctx.db)
                .select({ id: runProgress.id })
                .from(runProgress)
                .where(
                  and(
                    eq(runProgress.runId, runId),
                    eq(runProgress.phase, "awaiting_approval"),
                  ),
                )
                .limit(1);
              return waiting.length > 0;
            });
            const wallMs = Date.now() - startedAt;
            const usage = evalUsageReport.parse(
              await (await model.fetch("https://model.test/usage")).json(),
            );
            const [final] = await getDb(ctx.db)
              .select({ status: runTable.status })
              .from(runTable)
              .where(eq(runTable.id, runId));
            const proposals = await getDb(ctx.db)
              .select({
                images: photoGroupProposal.images,
                productKind: photoGroupProposal.productKind,
                productId: photoGroupProposal.productId,
              })
              .from(photoGroupProposal)
              .where(
                and(
                  eq(photoGroupProposal.runId, runId),
                  inArray(photoGroupProposal.state, ["proposed"]),
                ),
              );
            const score = scoreProposals(
              evalCase.expected,
              evalCase.photos.map((photo) => photo.key),
              proposals.map((proposal) => ({
                photos: proposal.images.map(
                  (entry) => photoKeys.get(entry.imageId) ?? entry.imageId,
                ),
                product:
                  proposal.productKind === "existing" && proposal.productId
                    ? (products.get(proposal.productId) ?? proposal.productId)
                    : null,
              })),
            );
            // An ambiguous case may be handed to a human instead of proposed.
            const reviewed =
              evalCase.allowReview === true && final?.status === "needs_review";
            return {
              case: evalCase.name,
              model: choice.model,
              effort: choice.effort,
              settled,
              status: final?.status ?? "missing",
              reachedApproval:
                settled && (final?.status === "running" || reviewed),
              wallMs,
              usage,
              costUsd: await evalCostUsd(choice.model, usage),
              ...score,
              exact: reviewed || score.exact,
              pairF1: reviewed ? 1 : score.pairF1,
              matchAccuracy: reviewed ? 1 : score.matchAccuracy,
            };
          };

          const outDir = path.join(
            evalWebRoot,
            "../../artifacts/agent-model-eval",
            new Date().toISOString().replace(/[:.]/gu, "-"),
          );
          mkdirSync(outDir, { recursive: true });
          const results: Awaited<ReturnType<typeof runCase>>[] = [];
          for (const choice of candidates)
            for (const evalCase of cases)
              for (let attempt = 0; attempt < repeats; attempt += 1) {
                const result = await runCase(evalCase, choice);
                results.push(result);
                // Written per run so a later failure keeps finished results.
                writeFileSync(
                  path.join(outDir, "results.jsonl"),
                  `${results.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
                );
              }

          const summary = candidates.map((choice) => {
            const mine = results.filter(
              (result) =>
                result.model === choice.model &&
                result.effort === choice.effort,
            );
            const mean = (values: number[]) =>
              values.reduce((sum, value) => sum + value, 0) /
              Math.max(1, values.length);
            return {
              candidate: `${choice.model}:${choice.effort}`,
              runs: mine.length,
              exact: mine.filter((result) => result.exact).length,
              meanPairF1: mean(mine.map((result) => result.pairF1)),
              meanMatchAccuracy: mean(
                mine.map((result) => result.matchAccuracy),
              ),
              reachedApproval: mine.filter((result) => result.reachedApproval)
                .length,
              meanWallSeconds: mean(mine.map((result) => result.wallMs)) / 1000,
              meanOutputTokens: mean(
                mine.map((result) => result.usage.outputTokens),
              ),
              meanInputTokens: mean(
                mine.map((result) => result.usage.inputTokens),
              ),
              meanCostUsd: meanEvalCostUsd(
                mine.map((result) => result.costUsd),
              ),
            };
          });
          writeFileSync(
            path.join(outDir, "report.json"),
            `${JSON.stringify({ summary, results }, null, 2)}\n`,
          );
          const table = [
            "| Candidate | Exact | Pair F1 | Match acc. | Reached approval | Wall s | In tok | Out tok | Cost/run |",
            "|---|---|---|---|---|---|---|---|---|",
            ...summary.map(
              (row) =>
                `| ${row.candidate} | ${row.exact}/${row.runs} | ${row.meanPairF1.toFixed(2)} | ${row.meanMatchAccuracy.toFixed(2)} | ${row.reachedApproval}/${row.runs} | ${row.meanWallSeconds.toFixed(0)} | ${Math.round(row.meanInputTokens)} | ${Math.round(row.meanOutputTokens)} | ${row.meanCostUsd === null ? "unknown" : `$${row.meanCostUsd.toFixed(3)}`} |`,
            ),
          ].join("\n");
          writeFileSync(path.join(outDir, "report.md"), `${table}\n`);
          console.log(`[agent-eval] report: ${outDir}\n${table}`);
          expect(results).toHaveLength(
            candidates.length * cases.length * repeats,
          );
        },
      );
    },
    24 * 60 * 60_000,
  );
});
