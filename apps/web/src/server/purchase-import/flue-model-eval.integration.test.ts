import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { importRunId, parseEntityId } from "@cubby/schemas/identifiers";
import { and, eq, inArray } from "drizzle-orm";
import { createWorkerdHarness } from "tooling/purchase-agent-workerd-harness";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { CF_ACCOUNT_ID, CF_AIG_GATEWAY_ID } from "~/server/cf-env";
import {
  aiAnalysis,
  importRun,
  importRunProgress,
  importRunTarget,
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
import { type EvalCase, flueModelEvalCases } from "./flue-model-eval.fixtures";
import { scoreProposals } from "./flue-model-eval.score";
import {
  startPhotoInventoryCoordinator,
  startPhotoInventoryRun,
} from "./run-service";

/**
 * Live photo-coordinator model comparison. Opt-in and billed: it runs the real
 * Flue agent in workerd against an isolated database, with its model calls
 * forwarded to Cubby's AI Gateway as each candidate. Run with
 * `pnpm --dir apps/web eval:flue-models`.
 */
const webRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const candidate = z.object({
  model: z.enum(["gpt-6-luna", "gpt-6-sol"]),
  effort: z.enum(["none", "low", "medium", "high"]),
});
type Candidate = z.infer<typeof candidate>;
const candidates = (
  process.env.FLUE_EVAL_CANDIDATES ??
  "gpt-6-luna:medium,gpt-6-luna:high,gpt-6-sol:medium,gpt-6-sol:high"
)
  .split(",")
  .map((entry) => {
    const [model, effort] = entry.split(":");
    return candidate.parse({ model, effort });
  });
const caseFilter = process.env.FLUE_EVAL_CASES?.split(",");
const cases = flueModelEvalCases.filter(
  (evalCase) => !caseFilter || caseFilter.includes(evalCase.name),
);
const repeats = Number(process.env.FLUE_EVAL_REPEATS ?? "1");
const RUN_TIMEOUT_MS = 8 * 60_000;

/**
 * USD per million tokens. Sol is the purchase agent's own catalog entry; Luna's
 * input and cached rates follow the app registry's cache pricing. Luna's output
 * rate is not recorded in the repo, so pass FLUE_EVAL_LUNA_OUTPUT_USD_PER_M or
 * read cost from the reported tokens.
 */
const PRICES = {
  "gpt-6-sol": { input: 2, cachedInput: 0.2, output: 10 },
  "gpt-6-luna": {
    input: 0.1,
    cachedInput: 0.01,
    output: process.env.FLUE_EVAL_LUNA_OUTPUT_USD_PER_M
      ? Number(process.env.FLUE_EVAL_LUNA_OUTPUT_USD_PER_M)
      : null,
  },
} satisfies Record<
  Candidate["model"],
  { input: number; cachedInput: number; output: number | null }
>;

const usageReport = z.object({
  requests: z.number(),
  failedRequests: z.number(),
  inputTokens: z.number(),
  cachedInputTokens: z.number(),
  outputTokens: z.number(),
  reasoningTokens: z.number(),
  modelMs: z.number(),
});
type Usage = z.infer<typeof usageReport>;

function costUsd(model: Candidate["model"], usage: Usage) {
  const price = PRICES[model];
  if (price.output === null) return null;
  const uncached = usage.inputTokens - usage.cachedInputTokens;
  return (
    (uncached * price.input +
      usage.cachedInputTokens * price.cachedInput +
      usage.outputTokens * price.output) /
    1_000_000
  );
}

function gatewayApiKey() {
  if (process.env.AI_GATEWAY_API_KEY) return process.env.AI_GATEWAY_API_KEY;
  const line = readFileSync(path.join(webRoot, ".env"), "utf8")
    .split("\n")
    .find((entry) => entry.startsWith("AI_GATEWAY_API_KEY="));
  const key = line?.slice("AI_GATEWAY_API_KEY=".length).replace(/^"|"$/gu, "");
  if (!key) throw new Error("AI_GATEWAY_API_KEY is required for the live eval");
  return key;
}

async function poll(done: () => Promise<boolean>) {
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await done()) return true;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return false;
}

describe.skipIf(process.env.FLUE_MODEL_EVAL !== "1")(
  "photo coordinator model eval",
  () => {
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
        const sessionId = `flue-eval-${crypto.randomUUID()}`;
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

        for (const key of [
          "WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE",
          "WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE_CACHED",
        ])
          process.env[key] = ctx.databaseUrl;
        const harness = createWorkerdHarness(ctx.databaseUrl, {
          main: "tooling/flue-eval-model.ts",
          vars: {
            GATEWAY_OPENAI_URL: `https://gateway.ai.cloudflare.com/v1/${CF_ACCOUNT_ID}/${CF_AIG_GATEWAY_ID}/openai`,
          },
          secrets: { AI_GATEWAY_API_KEY: gatewayApiKey() },
        });
        const { url } = await harness.listen();
        const model = harness.getWorker("cubby-test-model");

        const runCase = async (evalCase: EvalCase, choice: Candidate) => {
          const products = new Map<string, string>();
          for (const entry of evalCase.catalog) {
            const created = await createProductFixture(
              ctx.db,
              makeProductInput({
                name: entry.name,
                manufacturer: entry.manufacturer,
              }),
              ctx.actor,
            );
            products.set(created.entityId, entry.key);
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
                entityType: "image",
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
              .insert(importRunTarget)
              .values({
                runId: importRunId.parse(run.id),
                imageId: parseEntityId("image", fixture.id),
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
          await fetch(new URL("/dispatch", url), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              version: 1,
              type: "start_or_resume",
              runId: run.id,
              purpose: "photo_inventory",
              eventId: started.eventId,
            }),
          });
          const runId = importRunId.parse(run.id);
          const settled = await poll(async () => {
            const [row] = await getDb(ctx.db)
              .select({ status: importRun.status })
              .from(importRun)
              .where(eq(importRun.id, runId));
            if (row && row.status !== "running") return true;
            const waiting = await getDb(ctx.db)
              .select({ id: importRunProgress.id })
              .from(importRunProgress)
              .where(
                and(
                  eq(importRunProgress.runId, runId),
                  eq(importRunProgress.phase, "awaiting_approval"),
                ),
              )
              .limit(1);
            return waiting.length > 0;
          });
          const wallMs = Date.now() - startedAt;
          const usage = usageReport.parse(
            await (await model.fetch("https://model.test/usage")).json(),
          );
          const [final] = await getDb(ctx.db)
            .select({ status: importRun.status })
            .from(importRun)
            .where(eq(importRun.id, runId));
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
          return {
            case: evalCase.name,
            model: choice.model,
            effort: choice.effort,
            settled,
            status: final?.status ?? "missing",
            reachedApproval: settled && final?.status === "running",
            wallMs,
            usage,
            costUsd: costUsd(choice.model, usage),
            ...score,
          };
        };

        const results: Awaited<ReturnType<typeof runCase>>[] = [];
        for (const choice of candidates)
          for (const evalCase of cases)
            for (let attempt = 0; attempt < repeats; attempt += 1) {
              const result = await runCase(evalCase, choice);
              results.push(result);
              console.log(`[flue-eval] ${JSON.stringify(result)}`);
            }

        const summary = candidates.map((choice) => {
          const mine = results.filter(
            (result) =>
              result.model === choice.model && result.effort === choice.effort,
          );
          const mean = (values: number[]) =>
            values.reduce((sum, value) => sum + value, 0) /
            Math.max(1, values.length);
          const costs = mine.map((result) => result.costUsd);
          return {
            candidate: `${choice.model}:${choice.effort}`,
            runs: mine.length,
            exact: mine.filter((result) => result.exact).length,
            meanPairF1: mean(mine.map((result) => result.pairF1)),
            meanMatchAccuracy: mean(mine.map((result) => result.matchAccuracy)),
            reachedApproval: mine.filter((result) => result.reachedApproval)
              .length,
            meanWallSeconds: mean(mine.map((result) => result.wallMs)) / 1000,
            meanOutputTokens: mean(
              mine.map((result) => result.usage.outputTokens),
            ),
            meanInputTokens: mean(
              mine.map((result) => result.usage.inputTokens),
            ),
            meanCostUsd: costs.every((cost) => cost !== null)
              ? mean(costs.filter((cost): cost is number => cost !== null))
              : null,
          };
        });
        const outDir = path.join(
          webRoot,
          "../../artifacts/flue-model-eval",
          new Date().toISOString().replace(/[:.]/gu, "-"),
        );
        mkdirSync(outDir, { recursive: true });
        writeFileSync(
          path.join(outDir, "report.json"),
          `${JSON.stringify({ summary, results }, null, 2)}\n`,
        );
        const table = [
          "| Candidate | Exact | Pair F1 | Match acc. | Reached approval | Wall s | In tok | Out tok | Cost/run |",
          "|---|---|---|---|---|---|---|---|---|",
          ...summary.map(
            (row) =>
              `| ${row.candidate} | ${row.exact}/${row.runs} | ${row.meanPairF1.toFixed(2)} | ${row.meanMatchAccuracy.toFixed(2)} | ${row.reachedApproval}/${row.runs} | ${row.meanWallSeconds.toFixed(0)} | ${Math.round(row.meanInputTokens)} | ${Math.round(row.meanOutputTokens)} | ${row.meanCostUsd === null ? "n/a" : `$${row.meanCostUsd.toFixed(3)}`} |`,
          ),
        ].join("\n");
        writeFileSync(path.join(outDir, "report.md"), `${table}\n`);
        console.log(`[flue-eval] report: ${outDir}\n${table}`);
        await harness.close();
        expect(results).toHaveLength(
          candidates.length * cases.length * repeats,
        );
      },
      24 * 60 * 60_000,
    );
  },
);
