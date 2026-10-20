import { assessmentFamily } from "@cubby/schemas/assessment";
import { financialSpendingAdvice } from "@cubby/schemas/financial-booking";
import { recordStatementRowsInput } from "@cubby/schemas/statement-row";
import { WORKFLOW_EXECUTION_LIMITS } from "@cubby/shared/workflow-limits";
import { fromPartial } from "@total-typescript/shoehorn";
import { eq, sql } from "drizzle-orm";
import { createEntity } from "tooling/factories/create";
import { createRepoEntity } from "tooling/factories/repo";
import { buildKernelContext } from "tooling/scenarios/context";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { forEachConcurrently } from "~/lib/concurrency-limiter";
import { activateAiRefresh } from "~/server/ai/repo/ai-refresh";
import * as cfEnv from "~/server/cf-env";
import { getDb } from "~/server/db/helpers";
import { run } from "~/server/db/schema";
import * as spending from "~/server/domains/financial-transaction/repo/financial-spending";
import { recordStatementRows } from "~/server/domains/statement-import/repo/statement-row";
import * as publications from "~/server/domains/statement-import/repo/statement-suggestions";
import * as labels from "~/server/domains/statement-import/service/statement-suggestion-labels";
import { memoryDurableSteps } from "~/server/testing/durable-steps";
import { continueWorkflowRun } from "~/server/workflows/runs/continuation";
import type { WorkflowRunParams } from "~/server/workflows/runs/contract";
import type { WorkflowLauncher } from "~/server/workflows/runs/launcher";
import { runStepRunWorkflow } from "~/server/workflows/step-run-execution";

import { readRunSteps } from "../repo/run-step";
import { advanceStepRun, inspectStepRun } from "./step-run";
import { startSweep } from "./sweep";

// Advance only modeled external latency. PostgreSQL, prompts, cache lookup,
// batching, checkpoints, publication and successor ownership stay real.
function virtualLatency() {
  let now = Date.now();
  let unmodeled = 0;
  const pending: { at: number; resolve(): void }[] = [];
  return {
    now: () => now,
    async unmodeled<T>(work: () => Promise<T>) {
      unmodeled++;
      try {
        return await work();
      } finally {
        unmodeled--;
      }
    },
    delay: (ms: number) =>
      new Promise<void>((resolve) => pending.push({ at: now + ms, resolve })),
    async drive<T>(callback: () => Promise<T>) {
      const completion = { done: false };
      const result = callback();
      void result.then(
        () => {
          completion.done = true;
        },
        () => {
          completion.done = true;
        },
      );
      while (!completion.done) {
        // Give actual PostgreSQL I/O and batch preparation a turn before
        // releasing the next wave of modeled transport/publication delays.
        await new Promise((resolve) => setTimeout(resolve, 2));
        // Outstanding SQL cannot consume virtual time or stagger a batch of
        // publication slots according to this machine's response ordering.
        if (unmodeled) continue;
        const next = Math.min(...pending.map((entry) => entry.at));
        if (!Number.isFinite(next)) continue;
        now = Math.max(now, next);
        for (let index = pending.length - 1; index >= 0; index--) {
          const entry = pending[index]!;
          if (entry.at <= now) {
            pending.splice(index, 1);
            entry.resolve();
          }
        }
      }
      return result;
    },
  };
}

const gatewayInput = z.object({
  query: z.object({
    questions: z.record(
      z.string(),
      z.object({ criteria: z.record(z.string(), z.string()) }),
    ),
  }),
});

describe("statement Sweep throughput", () => {
  const ctx = withTestDb();

  // Host SQL completion order must not serialize simulated publication slots.
  it("keeps simulated latency stable across different SQL completion orders", async () => {
    const measure = async (delays: number[]) => {
      const clock = virtualLatency();
      const start = clock.now();
      await clock.drive(async () => {
        await clock.delay(10_000);
        await forEachConcurrently(delays, 4, async (ms) => {
          await clock.unmodeled(
            () => new Promise<void>((resolve) => setTimeout(resolve, ms)),
          );
          await clock.delay(25);
        });
      });
      return clock.now() - start;
    };
    expect(await measure([0, 0, 0, 0, 0, 0, 0, 0])).toBe(10_050);
    expect(await measure([0, 20, 5, 10, 20, 0, 10, 5])).toBe(10_050);
  });

  // A label-only port benchmark misses generation, cache preparation, both
  // create questions, DB publication, durable waits and successor overhead.
  it("measures cold complete suggestions through the actual workflow and batched transport", async () => {
    const total = 3_072;
    const owner = await createRepoEntity(ctx, "ledgerParty", {
      name: "Synthetic benchmark member",
      kind: "member",
    });
    await createRepoEntity(ctx, "financialAccount", {
      name: "Synthetic benchmark card",
      identity: { kind: "credit_card", issuer: null, network: "visa" },
      ledgerPartyId: owner.output.id,
      provisional: false,
      sourceAliases: [
        {
          source: "monarch",
          alias: "Synthetic Card (...4242)",
          externalAccountId: null,
        },
      ],
    });
    const category = await createEntity(
      buildKernelContext(ctx.db, ctx.actor.userId),
      "spendingCategory",
      { name: "Synthetic benchmark spending" },
    );
    for (let offset = 0; offset < total; offset += 400) {
      const count = Math.min(400, total - offset);
      await recordStatementRows(
        ctx.db,
        recordStatementRowsInput.parse({
          import: {
            source: "monarch",
            label: `synthetic-throughput-${offset}.csv`,
            fingerprint: `synthetic-throughput-cold-${offset}`,
            dateKind: "posted",
            rowCountDeclared: count,
            notes: null,
          },
          rows: Array.from({ length: count }, (_, position) => {
            const index = offset + position;
            return {
              accountDescriptor: "Synthetic Card (...4242)",
              statementDate: "2026-05-04",
              providerAmount: -(10 + index / 100),
              merchant: `Synthetic Merchant ${index}`,
              rawDescription: `SYNTHETIC PURCHASE ${index}`,
              sourceCategory: null,
              providerStatus: "posted",
              providerNotes: null,
              rowPosition: index + 1,
            };
          }),
        }),
        ctx.actor,
      );
    }
    await activateAiRefresh(ctx.db, "synthetic-throughput", {
      enabled: true,
      manifest: {},
    });

    const clock = virtualLatency();
    const epoch = clock.now();
    const date = vi.spyOn(Date, "now").mockImplementation(clock.now);
    // Spending advice is an external seam; keep the full label service and
    // real spending preview without adding generative model work to this
    // closed-choice transport benchmark.
    const label = labels.labelStatementSuggestions;
    const advice = vi
      .spyOn(labels, "labelStatementSuggestions")
      .mockImplementation((db, input) =>
        label(db, {
          ...input,
          spendingAdvice: async ({ judgment }) =>
            financialSpendingAdvice.parse({
              spendingCategoryId: category.id,
              categoryConfidence: "high",
              vendorName: judgment.create?.merchant,
              vendorConfidence: "high",
              counterparty: "business",
            }),
        }),
      );
    // Planner SQL is host work, just like publication SQL; it must not
    // stagger the benchmark's modeled transport clock by machine speed.
    const preview = spending.previewFinancialSpending;
    const planning = vi
      .spyOn(spending, "previewFinancialSpending")
      .mockImplementation((...args) => clock.unmodeled(() => preview(...args)));
    // Booking preparation consumes a third page allowance per charge. A faster
    // synthetic provider keeps this workload above the admission ceiling so
    // rate refusals and durable waits remain exercised after that extra work.
    const modelMs = 5_000;
    const starts: number[] = [];
    const finishes: number[] = [];
    const requests: { at: number; questions: number }[] = [];
    let activeModels = 0;
    let peakModels = 0;
    let refusals = 0;
    let page = 0;
    const refusedRequests = new Set<string>();
    let admissionPolls = 0;
    const egress = vi.spyOn(cfEnv, "getAiGatewayEgress").mockReturnValue(
      fromPartial<NonNullable<ReturnType<typeof cfEnv.getAiGatewayEgress>>>({
        fetch: async (request: Request) => {
          const { query } = gatewayInput.parse(await request.json());
          const recent = starts.filter((at) => at > clock.now() - 60_000);
          const retryAt = Math.max(
            recent.length >= 180 ? recent[0]! + 60_000 : 0,
            activeModels >= 64 ? Math.min(...finishes) : 0,
          );
          if (retryAt > clock.now()) {
            refusals++;
            const refused = JSON.stringify([page, query]);
            if (refusedRequests.has(refused)) admissionPolls++;
            refusedRequests.add(refused);
            return new Response(null, {
              status: 429,
              headers: {
                "x-cubby-admission-wait": "true",
                "retry-after": String(
                  Math.max(1, Math.ceil((retryAt - clock.now()) / 1_000)),
                ),
              },
            });
          }
          starts.push(clock.now());
          const end = clock.now() + modelMs;
          finishes.push(end);
          requests.push({
            at: clock.now() - epoch,
            questions: Object.keys(query.questions).length,
          });
          peakModels = Math.max(peakModels, ++activeModels);
          await clock.delay(modelMs);
          activeModels--;
          finishes.splice(finishes.indexOf(end), 1);
          return Response.json({
            result: {
              answers: Object.fromEntries(
                Object.entries(query.questions).map(([id, question]) => {
                  const keys = Object.keys(question.criteria);
                  return [
                    id,
                    {
                      type: "choice",
                      choice: keys[0],
                      confidence: 0.5,
                      probabilities: Object.fromEntries(
                        keys.map((key, index) => [
                          key,
                          index === 0 ? 0.5 : 0.5 / (keys.length - 1),
                        ]),
                      ),
                    },
                  ];
                }),
              ),
            },
          });
        },
      }),
    );
    let activePublications = 0;
    let peakPublications = 0;
    let published = 0;
    const publish = publications.publishChargeProposal;
    const publication = vi
      .spyOn(publications, "publishChargeProposal")
      .mockImplementation(async (...args) => {
        peakPublications = Math.max(peakPublications, ++activePublications);
        try {
          const result = await clock.unmodeled(() => publish(...args));
          await clock.delay(25);
          if (args[2].kind === "model" && result.outcome === "published")
            published++;
          return result;
        } finally {
          activePublications--;
        }
      });
    const launched: WorkflowRunParams[] = [];
    const launcher: WorkflowLauncher = {
      create: async (_purpose, _id, params) => {
        launched.push(params);
      },
      terminate: async () => {},
      status: async () => ({ state: "running", error: null }),
    };
    const instances: { pages: number; labelPages: number; forced: boolean }[] =
      [];
    let handoffs = 0;
    let waits = 0;
    let waitMs = 0;
    const failures: string[] = [];
    try {
      const runId = await startSweep(
        ctx.db,
        ctx.actor,
        {
          trigger: "manual",
          families: [{ family: "statement_transaction", scope: {} }],
        },
        launcher,
      );
      await clock.drive(async () => {
        while (launched.length) {
          const params = launched.shift()!;
          const durable = memoryDurableSteps();
          const instance = { pages: 0, labelPages: 0, forced: false };
          instances.push(instance);
          const startedAt = clock.now();
          await runStepRunWorkflow(
            {
              ...durable.steps,
              sleep: async (name, ms) => {
                await durable.steps.sleep(name, ms);
                waits++;
                waitMs += ms;
                await clock.delay(ms);
              },
            },
            {
              inspect: () => inspectStepRun(ctx.db, params),
              elapsedMs: () => clock.now() - startedAt,
              advance: async () => {
                instance.pages++;
                page++;
                const result = await advanceStepRun(
                  ctx.db,
                  params,
                  undefined,
                  launcher,
                );
                if (
                  result.kind === "continue" &&
                  result.execution?.phase === "statement_label"
                )
                  instance.labelPages++;
                return result;
              },
              boundary: async (_name, force) => {
                if (!force) return false;
                instance.forced = true;
                handoffs++;
                await clock.delay(10_000);
                await continueWorkflowRun(ctx.db, params, launcher);
                return true;
              },
              wait: async (_page, seconds) => {
                waits++;
                waitMs += seconds * 1_000;
                await clock.delay(seconds * 1_000);
              },
              fail: async (message) => {
                failures.push(message);
                return true;
              },
              recover: async () => {},
            },
          );
        }
      });
      const [owner] = await getDb(ctx.db)
        .select()
        .from(run)
        .where(eq(run.id, runId));
      const steps = await readRunSteps(ctx.db, runId);
      const { rows } = await getDb(ctx.db).execute<{
        complete: number;
        pending: number;
      }>(sql`
        SELECT count(*) FILTER (WHERE NOT coalesce((data->>'needsLabel')::boolean, false))::int AS complete,
          count(*) FILTER (WHERE coalesce((data->>'needsLabel')::boolean, false))::int AS pending
        FROM "AssessmentState" WHERE family = ${assessmentFamily.enum.statement_transaction} AND active
      `);
      const elapsedMs = clock.now() - epoch;
      const questions = requests.reduce(
        (sum, entry) => sum + entry.questions,
        0,
      );
      const labelElapsedMs = elapsedMs - requests[0]!.at;
      const startsPerMinute = Math.max(
        ...starts.map(
          (first) =>
            starts.filter((at) => at >= first && at < first + 60_000).length,
        ),
      );
      console.info(
        "STATEMENT_THROUGHPUT",
        JSON.stringify({
          suggestions: total,
          completed: rows[0]?.complete,
          questions,
          requests: requests.length,
          requestsPerSuggestion: requests.length / total,
          peakModelRequests: peakModels,
          peakDbPublications: peakPublications,
          published,
          elapsedMs,
          suggestionsPerMinute: (total * 60_000) / elapsedMs,
          labelElapsedMs,
          labelsPerMinute: (total * 60_000) / labelElapsedMs,
          maxStartsPerMinute: startsPerMinute,
          handoffs,
          waits,
          waitMs,
          admissionRefusals: refusals,
          admissionPolls,
          instances,
          pagePolicy: WORKFLOW_EXECUTION_LIMITS,
          latency: {
            modelMs,
            labelPublicationMs: 25,
            handoffMs: 10_000,
          },
        }),
      );
      expect(failures).toEqual([]);
      expect(owner?.status).toBe("completed");
      expect(
        steps.every((step) => step.failed === 0 && step.state === "done"),
      ).toBe(true);
      expect(rows[0]).toEqual({ complete: total, pending: 0 });
      expect(published).toBe(total);
      expect(questions).toBe(total * 2);
      expect(requests.length).toBeLessThan(questions);
      expect(peakPublications).toBeLessThanOrEqual(4);
      expect(peakModels).toBeGreaterThanOrEqual(30);
      expect(startsPerMinute).toBe(180);
      expect(waits).toBeGreaterThan(0);
      expect(refusals).toBeGreaterThan(0);
      // Parallel chunks may each defer once; no chunk may poll again inside
      // the same page instead of returning to the durable Workflow sleep.
      expect(admissionPolls).toBe(0);
      expect(handoffs).toBeGreaterThan(0);
      expect(instances.some((instance) => instance.labelPages > 2)).toBe(true);
    } finally {
      publication.mockRestore();
      egress.mockRestore();
      advice.mockRestore();
      planning.mockRestore();
      date.mockRestore();
    }
  }, 180_000);
});
