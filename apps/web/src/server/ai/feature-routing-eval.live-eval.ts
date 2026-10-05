import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { runEntityId } from "@cubby/schemas/identifiers";
import {
  normalizeImportAuditModelOutput,
  normalizeImportExtractionModelOutput,
} from "@cubby/schemas/purchase-import";
import { describe, expect, it } from "vitest";

import {
  type EvalCandidate,
  evalCandidates,
  evalCostUsd,
  type EvalUsage,
  evalWebRoot,
} from "~/server/purchase-import/agent-eval-live-support";

import { localSecret } from "../../../tooling/local-secret";
import {
  auditCases,
  recipeFlowCases,
  recipeEvidence,
  repairCases,
} from "./feature-routing-eval.fixtures";
import {
  type FeatureScore,
  type FeatureVerdict,
  scoreAudit,
  scoreRecipeFlow,
  scoreRepair,
} from "./feature-routing-eval.score";
import type { AiChatFeature } from "./features";
import type { StructuredRunPorts } from "./run-feature";

/**
 * Live routing eval for the structured reasoning-tier features: purchase
 * import audit, extraction repair, and recipe flow. Opt-in and billed: each
 * case places the production prompt through Cubby's AI Gateway as every
 * candidate, with the production schema, validator, and one-repair policy,
 * then scores the answer against a synthetic key. Run with
 * `pnpm --dir apps/web eval:features`; never part of CI.
 *
 * `FEATURE_EVAL_FEATURES` narrows to `audit`, `repair`, or `recipe-flow`;
 * `AGENT_EVAL_CANDIDATES` replaces each feature's default pair (Sol at its
 * production effort, Luna at high); `AGENT_EVAL_REPEATS` repeats each case.
 */
const apiKey = localSecret(["AI_GATEWAY_API_KEY"]);
if (!apiKey)
  throw new Error("AI_GATEWAY_API_KEY is required for the live eval");
process.env.AI_GATEWAY_API_KEY = apiKey;
// `~/env` snapshots `process.env` when first imported, so every module that
// reaches the gateway loads only after the key is in place; a static import
// would be hoisted above it and fail every call as a "Connection error".
const [
  { purchaseRepairRequest, settleRepairedExtraction },
  { purchaseAuditPrompt },
  { buildRecipeFlowRequest },
  { piCallTarget },
  { assessRecipeFlowCandidate, flowPromptInput },
  {
    PURCHASE_IMPORT_AUDIT_FEATURE,
    PURCHASE_IMPORT_REPAIR_FEATURE,
    RECIPE_FLOW_PRIMARY_FEATURE,
  },
  { runStructuredFeature },
] = await Promise.all([
  import("~/server/agents/purchase-import/extract"),
  import("~/server/agents/purchase-import/prompts"),
  import("~/server/clients/ai"),
  import("~/server/clients/ai-adapters"),
  import("~/server/services/recipe-flow/recipe-flow.service"),
  import("./features"),
  import("./run-feature"),
]);

const repeats = Number(process.env.AGENT_EVAL_REPEATS ?? "1");
const featureFilter = process.env.FEATURE_EVAL_FEATURES?.split(",");
const caseFilter = process.env.FEATURE_EVAL_CASES?.split(",");

type FeatureCase = {
  name: string;
  /** Place the case's production call(s) as `choice` and score the answer. */
  run: (
    choice: EvalCandidate,
    ports: StructuredRunPorts,
  ) => Promise<FeatureScore>;
};

/** A synthetic run id: the eval has no database to book usage against. */
const ctx = { runId: runEntityId.parse(crypto.randomUUID()) };

/** The production feature placed on the candidate, never served from cache. */
const asCandidate = <F extends AiChatFeature>(
  feature: F,
  choice: EvalCandidate,
): F => ({
  ...feature,
  model: choice.model,
  effort: choice.effort,
  cache: false,
});

/** A failed call is an answer to score, not a crash: production falls back. */
async function settle<T>(answer: Promise<T>): Promise<T | Error> {
  try {
    return await answer;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

const suites: Array<{
  name: string;
  feature: AiChatFeature;
  cases: FeatureCase[];
}> = [
  {
    name: "audit",
    feature: PURCHASE_IMPORT_AUDIT_FEATURE,
    cases: auditCases.map((entry) => ({
      name: entry.name,
      run: async (choice, ports) => {
        const observed = await settle(
          runStructuredFeature(
            asCandidate(PURCHASE_IMPORT_AUDIT_FEATURE, choice),
            purchaseAuditPrompt(entry.batch),
            { ...ctx, operation: "eval.purchaseImport.audit" },
            ports,
          ).then(normalizeImportAuditModelOutput),
        );
        return scoreAudit(entry.expected, observed);
      },
    })),
  },
  {
    name: "repair",
    feature: PURCHASE_IMPORT_REPAIR_FEATURE,
    cases: repairCases.map((entry) => ({
      name: entry.name,
      run: async (choice, ports) => {
        const observed = await settle(
          runStructuredFeature(
            asCandidate(PURCHASE_IMPORT_REPAIR_FEATURE, choice),
            purchaseRepairRequest(entry.capture, entry.previous),
            { ...ctx, operation: "eval.purchaseImport.repair" },
            ports,
          ).then((output) =>
            settleRepairedExtraction(
              normalizeImportExtractionModelOutput(output),
            ),
          ),
        );
        return scoreRepair(entry.expected, observed);
      },
    })),
  },
  {
    name: "recipe-flow",
    feature: RECIPE_FLOW_PRIMARY_FEATURE,
    cases: recipeFlowCases.map((entry) => ({
      name: entry.name,
      run: async (choice, ports) => {
        const request = buildRecipeFlowRequest(
          JSON.stringify(flowPromptInput(entry.recipe), null, 2),
          null,
        );
        const observed = await settle(
          runStructuredFeature(
            asCandidate(RECIPE_FLOW_PRIMARY_FEATURE, choice),
            request,
            {
              ...ctx,
              operation: "eval.generateRecipeFlow",
              // The production validator and its one repair turn.
              validate: (plan) => assessRecipeFlowCandidate(entry.recipe, plan),
            },
            ports,
          ).then((plan) => {
            const assessment = assessRecipeFlowCandidate(entry.recipe, plan);
            return assessment.ok
              ? { plan: assessment.plan, issues: [] }
              : new Error(assessment.issues.join("; "));
          }),
        );
        return scoreRecipeFlow(
          { ...entry.expected, ...recipeEvidence(entry.recipe) },
          observed,
        );
      },
    })),
  },
];

/** Production ports, tallying every completed call's tokens. */
function meteredPorts(usage: EvalUsage): StructuredRunPorts {
  return {
    callTarget: (model, call) => {
      const target = piCallTarget(model, call);
      return {
        ...target,
        complete: async (context, options) => {
          const started = Date.now();
          usage.requests += 1;
          // Counted before the call: a thrown transport failure never
          // returns a message, and the run loop aborts on any failure.
          usage.failedRequests += 1;
          const message = await target.complete(context, options);
          usage.failedRequests -= 1;
          usage.modelMs += Date.now() - started;
          if (
            message.stopReason === "error" ||
            message.stopReason === "aborted"
          )
            usage.failedRequests += 1;
          // pi subtracts cache reads and writes from `input`; total them back
          // as the Responses API reports them (writes bill at the input rate
          // here, as in the decision eval's proxy).
          usage.inputTokens +=
            message.usage.input +
            message.usage.cacheRead +
            message.usage.cacheWrite;
          usage.cachedInputTokens += message.usage.cacheRead;
          usage.outputTokens += message.usage.output;
          usage.reasoningTokens += message.usage.reasoning ?? 0;
          return message;
        },
      };
    },
  };
}

const emptyUsage = (): EvalUsage => ({
  requests: 0,
  failedRequests: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  modelMs: 0,
});

describe("structured feature routing eval", () => {
  it("scores candidate models on synthetic feature cases", async () => {
    const revision = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: evalWebRoot,
      encoding: "utf8",
    }).trim();
    const outDir = path.join(
      evalWebRoot,
      "../../artifacts/feature-routing-eval",
      new Date().toISOString().replace(/[:.]/gu, "-"),
    );
    mkdirSync(outDir, { recursive: true });
    const results: Array<{
      feature: string;
      case: string;
      model: EvalCandidate["model"];
      effort: EvalCandidate["effort"];
      wallMs: number;
      usage: EvalUsage;
      costUsd: number;
      verdict: FeatureVerdict;
      reasons: string[];
    }> = [];
    const selected = suites.filter(
      (suite) => !featureFilter || featureFilter.includes(suite.name),
    );
    for (const suite of selected) {
      const candidates = evalCandidates(
        `gpt-6-sol:${suite.feature.effort},gpt-6-luna:high`,
      );
      const cases = suite.cases.filter(
        (entry) => !caseFilter || caseFilter.includes(entry.name),
      );
      for (const choice of candidates)
        for (const entry of cases)
          for (let attempt = 0; attempt < repeats; attempt += 1) {
            const usage = emptyUsage();
            const started = Date.now();
            const score = await entry.run(choice, meteredPorts(usage));
            // A transport or provider failure says nothing about the model's
            // judgment: stop instead of scoring it as a miss.
            if (usage.failedRequests > 0)
              throw new Error(
                `${suite.name}/${entry.name} on ${choice.model}: provider call failed (${score.reasons.join("; ")})`,
              );
            results.push({
              feature: suite.name,
              case: entry.name,
              model: choice.model,
              effort: choice.effort,
              wallMs: Date.now() - started,
              usage,
              costUsd: evalCostUsd(choice.model, usage),
              ...score,
            });
            writeFileSync(
              path.join(outDir, "results.jsonl"),
              `${results.map((row) => JSON.stringify(row)).join("\n")}\n`,
            );
          }
    }

    const groups = new Map<string, typeof results>();
    for (const row of results) {
      const key = `${row.feature}|${row.model}:${row.effort}`;
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    const mean = (values: number[]) =>
      values.reduce((sum, value) => sum + value, 0) /
      Math.max(1, values.length);
    const summary = [...groups].map(([key, rows]) => {
      const [feature, candidate] = key.split("|");
      const count = (verdict: FeatureVerdict) =>
        rows.filter((row) => row.verdict === verdict).length;
      return {
        feature,
        candidate,
        runs: rows.length,
        correct: count("correct"),
        unsafe: count("unsafe"),
        reviewableMiss: count("reviewable_miss"),
        meanWallSeconds: mean(rows.map((row) => row.wallMs)) / 1_000,
        meanInputTokens: mean(rows.map((row) => row.usage.inputTokens)),
        meanOutputTokens: mean(rows.map((row) => row.usage.outputTokens)),
        meanCostUsd: mean(rows.map((row) => row.costUsd)),
      };
    });
    const replay = [
      process.env.FEATURE_EVAL_FEATURES &&
        `FEATURE_EVAL_FEATURES=${process.env.FEATURE_EVAL_FEATURES}`,
      process.env.AGENT_EVAL_CANDIDATES &&
        `AGENT_EVAL_CANDIDATES=${process.env.AGENT_EVAL_CANDIDATES}`,
      repeats > 1 && `AGENT_EVAL_REPEATS=${repeats}`,
      "pnpm --dir apps/web eval:features",
    ]
      .filter(Boolean)
      .join(" ");
    writeFileSync(
      path.join(outDir, "report.json"),
      `${JSON.stringify({ revision, replay, summary, results }, null, 2)}\n`,
    );
    const table = [
      `Revision ${revision}; replay: \`${replay}\``,
      "",
      "| Feature | Candidate | Correct | Unsafe | Reviewable miss | Wall s | In tok | Out tok | Cost/run |",
      "|---|---|---|---|---|---|---|---|---|",
      ...summary.map(
        (row) =>
          `| ${row.feature} | ${row.candidate} | ${row.correct}/${row.runs} | ${row.unsafe} | ${row.reviewableMiss} | ${row.meanWallSeconds.toFixed(1)} | ${Math.round(row.meanInputTokens)} | ${Math.round(row.meanOutputTokens)} | $${row.meanCostUsd.toFixed(4)} |`,
      ),
    ].join("\n");
    writeFileSync(path.join(outDir, "report.md"), `${table}\n`);
    console.log(`[feature-routing-eval] report: ${outDir}\n${table}`);
    expect(results.length).toBeGreaterThan(0);
  });
});
