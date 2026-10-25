import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  aiEvaluationTarget,
  aiProvenance,
  aiRefreshRunInput,
} from "@cubby/schemas/ai-evaluation";
import { fromPartial } from "@total-typescript/shoehorn";
import { eq, inArray } from "drizzle-orm";
import { countTestDbQueries, withTestDb } from "tooling/test-setup";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  runDecisionChoice,
  settleDecisionChoices,
  decisionModelFor,
} from "~/server/ai/decision-model";
import { DECISION_CONTEXT_BYTE_LIMIT } from "~/server/ai/decision-request-batch";
import { gatewayEgressInput } from "~/server/ai/gateway-egress-contract";
import { PRODUCT_IDENTITY_FEATURE } from "~/server/ai/policy/feature-identity";
import { dependencyStamps } from "~/server/ai/policy/refresh-manifest";
import { productIdentityPrompt } from "~/server/ai/product-identity";
import { claimAiEvaluationPage } from "~/server/ai/repo/ai-evaluation";
import { enqueueAiEvaluations } from "~/server/ai/repo/ai-evaluation-requests";
import { activateAiRefresh } from "~/server/ai/repo/ai-refresh";
import type { AiRunContext } from "~/server/ai/run-feature";
import { setCfEnv } from "~/server/cf-env";
import { getDb } from "~/server/db/helpers";
import { aiEvaluation, aiUsage, job } from "~/server/db/schema";
import {
  preparedProductIdentityPair,
  prepareProductIdentityPair,
} from "~/server/domains/product/repo/match/product-identity-snapshot";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import {
  executeAiRefreshPage,
  productEvaluationPageAdapter,
} from "~/server/domains/run/service/ai-refresh";
import { withJobExecution } from "~/server/generic/jobs/context";
import { claimJob, enqueueJob } from "~/server/generic/jobs/repo/jobs";
import {
  createProductIdentityFixture,
  makeProductInput,
} from "~/server/testing/repo.fixtures";

type SentInput = {
  state: string;
  questions: Record<
    string,
    { instructions: string; criteria: Record<string, string> }
  >;
};
function installTransport(
  run: (input: SentInput, model: string) => Promise<Response>,
) {
  vi.stubEnv("AI_GATEWAY_API_KEY", "synthetic-page-token");
  setCfEnv(
    fromPartial<Env>({
      AI_GATEWAY_EGRESS: {
        getByName: () =>
          fromPartial<ReturnType<Env["AI_GATEWAY_EGRESS"]["getByName"]>>({
            fetch: async (request: Request) => {
              const body = gatewayEgressInput.parse(await request.json());
              return run(
                body.query as SentInput,
                body.endpoint.replace("run/", ""),
              );
            },
          }),
      },
    }),
  );
}
const answer = (input: SentInput) =>
  Response.json({
    result: {
      usage: { input_tokens: 100, output_tokens: 10 },
      answers: Object.fromEntries(
        Object.entries(input.questions).map(([key, question]) => {
          const choices = Object.keys(question.criteria);
          return [
            key,
            {
              type: "choice",
              choice: choices[0],
              confidence: 0.9,
              probabilities: Object.fromEntries(
                choices.map((choice, index) => [
                  choice,
                  index === 0 ? 0.9 : 0.1 / (choices.length - 1),
                ]),
              ),
            },
          ];
        }),
      ),
    },
  });
afterEach(() => {
  setCfEnv();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Product page transport packing", () => {
  const ctx = withTestDb();
  it.each([1, 100])(
    "packs %i real pair slots through cache/transport and measures the wrapped adapter",
    async (slotCount) => {
      const activation = await activateAiRefresh(
        ctx.db,
        "synthetic-transport-page",
        { enabled: true },
      );
      const runId = await ensureRun(ctx.db, ctx.actor, {
        purpose: "ai_refresh",
        trigger: "scheduled",
        status: "running",
        input: aiRefreshRunInput.parse({ kind: "ai_refresh", activation }),
      });
      const products = [];
      for (let index = 0; index <= slotCount; index++)
        products.push(
          await createProductIdentityFixture(
            ctx.db,
            makeProductInput({
              name: `Synthetic distinct pair product ${index}`,
            }),
            ctx.actor,
          ),
        );
      const productIds = products.map((product) => product.entityId);
      const pairs = [];
      for (const productId of productIds.slice(1)) {
        const pair = await prepareProductIdentityPair(ctx.db, [
          productIds[0]!,
          productId,
        ]);
        if (!pair) throw new Error("Synthetic pair preparation missing");
        pairs.push(pair);
      }
      const enrolled = await enqueueAiEvaluations(
        ctx.db,
        pairs.map((pair, sequence) => ({
          input: {
            runId,
            executionKind: "ai_refresh",
            shareKey: null,
            feature: "product-identity",
            target: aiEvaluationTarget.parse({
              kind: "product_pair",
              entity: "product",
              recordId: pair.productIds[0],
              otherId: pair.productIds[1],
              field: null,
              assessmentIds: [],
            }),
            provenance: aiProvenance.parse({
              dependencies: dependencyStamps(activation.manifest, [
                "product-identity",
              ]),
              inputFingerprint: pair.fingerprint,
              optionFingerprint: "canonical-product-pairs-v1",
              model: null,
            }),
            snapshot: pair,
          },
          sequence,
        })),
      );
      const [anchor] = await getDb(ctx.db)
        .select()
        .from(job)
        .where(eq(job.key, `ai-evaluation:${enrolled[0]!.id}`));
      const requests: { input: SentInput; model: string }[] = [];
      let active = 0,
        peak = 0;
      installTransport(async (input, model) => {
        active++;
        peak = Math.max(peak, active);
        requests.push({ input, model });
        await Promise.resolve();
        active--;
        return answer(input);
      });
      const claim = await countTestDbQueries(() =>
        claimAiEvaluationPage(ctx.db, anchor!.id),
      );
      expect(claim.result).toHaveLength(slotCount);
      const adapter = productEvaluationPageAdapter({
        productIdentityPorts: { model: "typesafe/jev" },
      });
      const execution = await countTestDbQueries(() =>
        executeAiRefreshPage(ctx.db, claim.result, adapter),
      );
      expect(requests.length).toBeGreaterThan(slotCount === 1 ? 0 : 1);
      expect(requests.length).toBeLessThanOrEqual(slotCount);
      const sizes = requests.map(
        ({ input }) => Object.keys(input.questions).length,
      );
      expect(sizes.reduce((sum, count) => sum + count, 0)).toBe(slotCount);
      expect(Math.max(...sizes)).toBeLessThanOrEqual(64);
      expect(Math.max(...sizes)).toBeGreaterThan(slotCount === 1 ? 0 : 1);
      expect(peak).toBeLessThanOrEqual(4);
      for (const { input, model } of requests) {
        expect(model).toBe("typesafe/jev");
        expect(
          new TextEncoder().encode(JSON.stringify(input)).byteLength,
        ).toBeLessThanOrEqual(DECISION_CONTEXT_BYTE_LIMIT);
        expect(input.state).toContain(
          slotCount === 1
            ? "Synthetic distinct pair product"
            : "Independent decisions",
        );
        for (const question of Object.values(input.questions))
          expect(
            (slotCount === 1 ? input.state : question.instructions).match(
              /Synthetic distinct pair product/g,
            ),
          ).toHaveLength(2);
      }
      const settled = await getDb(ctx.db)
        .select()
        .from(aiEvaluation)
        .where(
          inArray(
            aiEvaluation.id,
            enrolled.map((row) => row.id),
          ),
        );
      expect(settled.every((row) => row.state === "completed")).toBe(true);
      const coldUsage = await getDb(ctx.db)
        .select()
        .from(aiUsage)
        .where(eq(aiUsage.runId, runId));
      expect(coldUsage).toHaveLength(requests.length);
      expect(
        coldUsage.every((row) => row.jobId === null && row.entityId === null),
      ).toBe(true);
      const usage: AiRunContext = {
        db: ctx.db,
        runId,
        operation: "product-identity",
      };
      const coldRequests = requests.length;
      const capturedPairs = claim.result.map((entry) =>
        preparedProductIdentityPair.parse(entry.evaluation.snapshot),
      );
      const warm = await settleDecisionChoices(capturedPairs, (pair) => ({
        ...productIdentityPrompt(JSON.stringify([pair.first, pair.second])),
        feature: PRODUCT_IDENTITY_FEATURE,
        decisionModel: "typesafe/jev",
        usage,
      }));
      expect(warm.every((result) => result.status === "fulfilled")).toBe(true);
      expect(requests).toHaveLength(coldRequests);
      const allUsage = await getDb(ctx.db)
        .select()
        .from(aiUsage)
        .where(eq(aiUsage.runId, runId));
      expect(allUsage.filter((row) => row.transport === "cache")).toHaveLength(
        slotCount,
      );
      const output = resolve(process.cwd(), "../../artifacts/page-execution");
      await mkdir(output, { recursive: true });
      await writeFile(
        resolve(output, `wrapped-product-page-${slotCount}.json`),
        JSON.stringify(
          {
            slots: slotCount,
            claimStatements: claim.queryCount,
            executionStatements: execution.queryCount,
            packedQuestions: sizes,
            requests: requests.length,
            peak,
            statements: execution.statements,
          },
          null,
          2,
        ),
      );
    },
    120_000,
  );

  it("bounds many byte-limited chunks, isolates transport errors and retains routing/cache identity", async () => {
    const activation = await activateAiRefresh(
      ctx.db,
      "synthetic-bounded-transport",
      { enabled: true },
    );
    const runId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "ai_refresh",
      trigger: "scheduled",
      status: "running",
      input: aiRefreshRunInput.parse({ kind: "ai_refresh", activation }),
    });
    const usage: AiRunContext = {
      db: ctx.db,
      runId,
      operation: "product-identity",
    };
    const requests: { model: string; count: number }[] = [];
    let active = 0,
      peak = 0;
    installTransport(async (input, model) => {
      active++;
      peak = Math.max(peak, active);
      requests.push({ model, count: Object.keys(input.questions).length });
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      active--;
      if (
        Object.values(input.questions).some((question) =>
          question.instructions.includes("synthetic-refusal"),
        )
      )
        return new Response("Synthetic provider refusal", { status: 400 });
      return answer(input);
    });
    const questions = Array.from({ length: 100 }, (_, index) => ({
      ...productIdentityPrompt(
        `${index === 7 ? "synthetic-refusal" : "synthetic-valid"} ${index} ${"e".repeat(3000)}`,
      ),
      feature: PRODUCT_IDENTITY_FEATURE,
      usage,
    }));
    const expectedModels = questions.map((question) =>
      decisionModelFor(question),
    );
    const settled = await settleDecisionChoices(
      questions,
      (question) => question,
    );
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
    expect(
      settled.filter((result) => result.status === "fulfilled").length,
    ).toBeGreaterThan(80);
    expect(settled[7]?.status).toBe("rejected");
    for (const model of new Set(expectedModels))
      expect(
        requests
          .filter((request) => request.model === model)
          .reduce((sum, request) => sum + request.count, 0),
      ).toBe(expectedModels.filter((entry) => entry === model).length);
    const count = requests.length;
    const success = questions.find(
      (_, index) => settled[index]?.status === "fulfilled",
    )!;
    await runDecisionChoice(success);
    expect(requests).toHaveLength(count);
    const invalid = await settleDecisionChoices(
      [
        { ...success, subject: "synthetic oversize " + "x".repeat(33_000) },
        success,
      ],
      (question) => question,
    );
    expect(invalid.map((result) => result.status)).toEqual([
      "rejected",
      "fulfilled",
    ]);
  }, 30_000);
  it("flushes misses beside busy, oversized and malformed questions", async () => {
    const activation = await activateAiRefresh(ctx.db, "synthetic-cache-wave", {
      enabled: true,
    });
    const runId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "ai_refresh",
      trigger: "scheduled",
      status: "running",
      input: aiRefreshRunInput.parse({ kind: "ai_refresh", activation }),
    });
    const usage: AiRunContext = {
      db: ctx.db,
      runId,
      operation: "product-identity",
    };
    const question = (subject: string) => ({
      ...productIdentityPrompt(subject),
      feature: PRODUCT_IDENTITY_FEATURE,
      decisionModel: "typesafe/jev" as const,
      usage,
    });
    const busy = question("synthetic-busy-question");
    const held = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    installTransport(async (input) => {
      if (input.state === busy.subject) {
        held.resolve();
        await release.promise;
      }
      const response = await answer(input).json();
      for (const [key, entry] of Object.entries(input.questions)) {
        if (
          entry.instructions.includes("synthetic-malformed-answer") ||
          input.state === "synthetic-malformed-answer"
        )
          response.result.answers[key].probabilities = Object.fromEntries(
            Object.keys(entry.criteria).map((choice) => [choice, 0]),
          );
      }
      return Response.json(response);
    });
    const pending = runDecisionChoice(busy);
    await held.promise;
    const saved = await enqueueJob(ctx.db, {
      key: "synthetic-cache-wave-owner",
      kind: "synthetic.cache",
      input: {},
    });
    const claim = await claimJob(ctx.db, saved.id);
    if (!claim) throw new Error("Synthetic cache wave claim missing");
    let settled;
    try {
      settled = await withJobExecution(ctx.db, claim, () =>
        settleDecisionChoices(
          [
            busy,
            question("synthetic-valid-sibling"),
            question("synthetic-malformed-answer"),
            question("x".repeat(33_000)),
          ],
          (entry) => entry,
        ),
      );
    } finally {
      release.resolve();
      await pending;
    }
    expect(settled.map((entry) => entry.status)).toEqual([
      "rejected",
      "fulfilled",
      "rejected",
      "rejected",
    ]);
    await expect(runDecisionChoice(busy)).resolves.toHaveProperty(
      "selectedIndex",
      0,
    );
  }, 30_000);
});
