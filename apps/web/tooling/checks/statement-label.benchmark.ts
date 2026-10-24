import { AsyncLocalStorage } from "node:async_hooks";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { resolve } from "node:path";
import { setImmediate } from "node:timers/promises";

import { assessmentFamily } from "@cubby/schemas/assessment";
import { buildActorContext } from "@cubby/schemas/context";
import { financialSpendingAdvice } from "@cubby/schemas/financial-booking";
import { recordSourceTransactionRecordsInput } from "@cubby/schemas/source-transaction-record";
import { STATEMENT_LABEL_REVISION } from "@cubby/schemas/statement-suggestion";
import { testUserId } from "@cubby/schemas/testing";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { expect, it, vi } from "vitest";

import * as decisionModel from "~/server/ai/decision-model";
import { createDatabase } from "~/server/db/database-runtime";
import { withDatabaseOperationMetrics } from "~/server/db/db-observability";
import {
  observePgPoolAndClientQueries,
  tracePool,
} from "~/server/db/db-pg-tracing";
import { getDb } from "~/server/db/helpers";
import * as schema from "~/server/db/schema";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import { recordSourceTransactionRecords } from "~/server/domains/transaction-import/repo/source-transaction-record";
import { answering } from "~/server/domains/transaction-import/repo/statement-decision-port.fixtures";
import { generateStatementSuggestionPage } from "~/server/domains/transaction-import/repo/statement-suggestions";
import { labelStatementSuggestions } from "~/server/domains/transaction-import/service/statement-suggestion-labels";
import type { PageWork } from "~/server/generic/jobs/page-work";

import { seedBaseWorld } from "../factories/base-world";
import { createEntity } from "../factories/create";
import { createRepoIdentity } from "../factories/repo";
import { buildKernelContext } from "../scenarios/context";
import { leaseNamedDatabase } from "../test-database-lease";

const output = resolve(
  import.meta.dirname,
  "../../../../artifacts/statement-label-benchmark",
);
const phaseScope = new AsyncLocalStorage<string>();
const heap = () => process.memoryUsage().heapUsed;
const sizes = (process.env.CUBBY_BENCH_SIZES ?? "8,32,64,128")
  .split(",")
  .map(Number);
const reports: unknown[] = [];

it.each(sizes)(
  "measures a fresh synthetic page of %i charges without providers",
  async (size) => {
    mkdirSync(output, { recursive: true });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("Benchmark forbids fetch"))),
    );
    const name = `cubby_sim_${randomBytes(8).toString("hex")}`;
    const setupStart = performance.now();
    const { lease, prepared: pool } = await leaseNamedDatabase(
      {
        adminUrl: "postgresql://postgres:password@127.0.0.1:55432/postgres",
        name,
        retention: "retain",
      },
      async ({ databaseUrl }) =>
        new Pool({ connectionString: databaseUrl, max: 8 }),
    );
    const querySources = new Map<string, number>();
    const observed = observePgPoolAndClientQueries(
      tracePool(pool, "strong"),
      (text) => {
        const tables = [
          ...text.matchAll(
            /\b(?:FROM|JOIN|UPDATE|INTO)\s+"([A-Za-z][A-Za-z0-9_]*)"/giu,
          ),
        ].map((match) => match[1]);
        const querySource = `${phaseScope.getStore() ?? "outside"}:${tables.join(",") || text.trim().split(/\s/u)[0]}`;
        querySources.set(querySource, (querySources.get(querySource) ?? 0) + 1);
      },
    );
    const client = drizzle({ client: observed, schema });
    const db = createDatabase(() => ({
      client,
      withConnection: async (run) => {
        const connection = await observed.connect();
        try {
          return await run(drizzle({ client: connection, schema }));
        } finally {
          connection.release();
        }
      },
    }));
    const actor = buildActorContext(
      testUserId("synthetic-statement-benchmark"),
    );
    const ctx = { db, actor };
    try {
      await seedBaseWorld(client);
      await client.insert(schema.user).values({
        id: actor.userId,
        name: "Synthetic benchmark member",
        email: "benchmark@example.test",
        emailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const owner = await createRepoIdentity(ctx, "ledgerParty", {
        name: "Synthetic benchmark member",
        kind: "member",
      });
      const account = await createRepoIdentity(ctx, "financialAccount", {
        name: "Synthetic benchmark card",
        ledgerPartyId: owner.output.id,
        provisional: false,
        identity: { kind: "credit_card", issuer: null, network: "visa" },
        sourceAliases: [
          {
            source: "monarch",
            alias: "Synthetic benchmark card",
            externalAccountId: null,
          },
        ],
      });
      const candidates = Number(process.env.CUBBY_BENCH_CANDIDATES ?? "0");
      const evidenceBytes = Number(process.env.CUBBY_BENCH_BYTES ?? "0");
      const kind = process.env.CUBBY_BENCH_KIND ?? "other";
      const adviceMode = process.env.CUBBY_BENCH_ADVICE ?? "injected";
      if (
        !Number.isSafeInteger(candidates) ||
        candidates < 0 ||
        candidates > 128 ||
        !Number.isSafeInteger(evidenceBytes) ||
        evidenceBytes < 0 ||
        evidenceBytes > 16_000 ||
        !["other", "purchase"].includes(kind) ||
        !["injected", "decision-port"].includes(adviceMode)
      )
        throw new Error("Invalid benchmark variant");
      if (adviceMode === "decision-port")
        for (let index = 0; index < 16; index++)
          await createEntity(
            buildKernelContext(db, actor.userId),
            "spendingCategory",
            {
              name: `Synthetic spending category ${index}`,
            },
          );
      for (let index = 0; index < candidates; index++)
        await createRepoIdentity(ctx, "financialTransaction", {
          accountId: account.output.id,
          kind: "purchase",
          status: "posted",
          amount: 42,
          transactionDate: "2026-05-04",
          postedDate: "2026-05-04",
          merchant: `Synthetic candidate ${index}`,
          rawDescription: `SYNTHETIC CANDIDATE ${index} ${"x".repeat(evidenceBytes)}`,
        });
      const runId = await ensureRun(db, actor, { purpose: "background" });
      const answer = answering({ kind, counterparty: "business" });
      let providerQuestions = 0;
      const port: decisionModel.DecisionPort = async (input) => {
        providerQuestions++;
        const criteria = input.questions.selection.criteria;
        const labels = Object.values(criteria);
        if (
          labels.includes("same_charge") ||
          labels.includes("person") ||
          labels.includes("purchase")
        )
          return answer(input);
        const keys = Object.keys(criteria);
        const choice = keys[0];
        if (!choice) throw new Error("Synthetic question has no choices");
        return {
          answers: {
            selection: {
              type: "choice",
              choice,
              confidence: 0.97,
              probabilities: Object.fromEntries(
                keys.map((key) => [
                  key,
                  key === choice ? 0.97 : 0.03 / (keys.length - 1),
                ]),
              ),
            },
          },
        };
      };
      const spendingAdvice = async () =>
        financialSpendingAdvice.parse({
          vendorName: "Synthetic benchmark business",
          vendorConfidence: "high",
          counterparty: "business",
        });
      const realSettle = decisionModel.settleDecisionChoices;
      let queuedQuestions = 0;
      let queuedPromptBytes = 0;
      let heapAtDecisionEntry = 0;
      let contextFitsCalls = 0;
      let contextFitsMs = 0;
      let renderedPromptBytes = 0;
      const realFits = decisionModel.decisionChoiceFitsContext;
      const fitProbe = vi
        .spyOn(decisionModel, "decisionChoiceFitsContext")
        .mockImplementation((args) => {
          // Probe histories must not retain rejected suffix prompts during heap sampling.
          fitProbe.mockClear();
          const started = performance.now();
          try {
            contextFitsCalls++;
            renderedPromptBytes +=
              Buffer.byteLength(args.subject) + Buffer.byteLength(args.rules);
            return realFits(args);
          } finally {
            contextFitsMs += performance.now() - started;
          }
        });
      const settleProbe = vi
        .spyOn(decisionModel, "settleDecisionChoices")
        .mockImplementation(async (items, questionFor, options) => {
          settleProbe.mockClear();
          queuedQuestions += items.length;
          queuedPromptBytes += items.reduce((total, item) => {
            const args = questionFor(item);
            return (
              total +
              Buffer.byteLength(args.subject) +
              Buffer.byteLength(args.rules)
            );
          }, 0);
          heapAtDecisionEntry = Math.max(heapAtDecisionEntry, heap());
          return realSettle(items, questionFor, options);
        });
      const setupMs = performance.now() - setupStart;
      const index = 0;
      if (!Number.isSafeInteger(size) || size < 1 || size > 512)
        throw new Error("Invalid benchmark size");
      const seedStart = performance.now();
      const recorded = await recordSourceTransactionRecords(
        db,
        recordSourceTransactionRecordsInput.parse({
          import: {
            source: "monarch",
            label: `synthetic-benchmark-${index}.csv`,
            fingerprint: `synthetic-benchmark-${index}`,
          },
          rows: Array.from({ length: size }, (_, row) => ({
            accountDescriptor: "Synthetic benchmark card",
            statementDate: "2026-05-04",
            providerAmount: candidates ? -42 : -(1000 + index * 1000 + row),
            merchant: `Synthetic merchant ${index}-${row}`,
            providerTransactionId: `synthetic-${index}-${row}`,
            rawDescription: `SYNTHETIC STATEMENT ${index}-${row} ${"y".repeat(evidenceBytes)}`,
            sourceCategory: "Other",
            providerStatus: "posted",
            rowPosition: row + 1,
          })),
        }),
        actor,
      );
      let after: Parameters<
        typeof generateStatementSuggestionPage
      >[1]["after"] = null;
      do {
        const generated = await generateStatementSuggestionPage(db, {
          after,
          runId: null,
          limit: 128,
        });
        expect(generated.failed).toEqual([]);
        after = generated.next;
      } while (after);
      const seedMs = performance.now() - seedStart;
      global.gc?.();
      const heapBefore = heap();
      let peakHeap = heapBefore;
      const phases: Record<
        string,
        {
          wallMs: number;
          queries: number;
          queryActiveWallMs: number;
          querySumMs: number;
          acquireActiveWallMs: number;
          clientQueueActiveWallMs: number;
          heapStart: number;
          heapEnd: number;
        }
      > = {};
      const work: PageWork = {
        add: () => {},
        time: (phase, run) =>
          phaseScope.run(phase, () =>
            withDatabaseOperationMetrics(async (metrics) => {
              const started = performance.now();
              const heapStart = heap();
              try {
                return await run();
              } finally {
                peakHeap = Math.max(peakHeap, heap());
                phases[phase] = {
                  wallMs: performance.now() - started,
                  queries: metrics.queryCount,
                  queryActiveWallMs: metrics.queryActiveWallMs,
                  querySumMs: metrics.queryDurationSumMs,
                  acquireActiveWallMs: metrics.acquireActiveWallMs,
                  clientQueueActiveWallMs: metrics.clientQueueActiveWallMs,
                  heapStart,
                  heapEnd: heap(),
                };
              }
            }),
          ),
      };
      querySources.clear();
      providerQuestions = 0;
      queuedQuestions = 0;
      queuedPromptBytes = 0;
      heapAtDecisionEntry = 0;
      contextFitsCalls = 0;
      contextFitsMs = 0;
      renderedPromptBytes = 0;
      const profiler =
        process.env.CUBBY_BENCH_PROFILE === "1" ? new Session() : null;
      if (profiler) {
        profiler.connect();
        await profiler.post("Profiler.enable");
        await profiler.post("Profiler.start");
      }
      const started = performance.now();
      const cpuStart = process.cpuUsage();
      const measured = await withDatabaseOperationMetrics(async (metrics) => {
        const outcome = await labelStatementSuggestions(db, {
          limit: size,
          runId,
          port,
          ...(adviceMode === "injected" && { spendingAdvice }),
          work,
        });
        return {
          outcome,
          queries: metrics.queryCount,
          queryActiveWallMs: metrics.queryActiveWallMs,
          querySumMs: metrics.queryDurationSumMs,
          acquireActiveWallMs: metrics.acquireActiveWallMs,
          clientQueueActiveWallMs: metrics.clientQueueActiveWallMs,
        };
      });
      const wallMs = performance.now() - started;
      const cpu = process.cpuUsage(cpuStart);
      if (profiler) {
        const { profile } = await profiler.post("Profiler.stop");
        writeFileSync(
          resolve(
            output,
            `cpu-${size}-${candidates}-${evidenceBytes}-${kind}-${adviceMode}.cpuprofile`,
          ),
          JSON.stringify(profile),
        );
        profiler.disconnect();
      }
      peakHeap = Math.max(peakHeap, heap(), heapAtDecisionEntry);
      fitProbe.mockClear();
      settleProbe.mockClear();
      await setImmediate();
      global.gc?.();
      const heapAfterGc = heap();
      expect(measured.outcome.failed).toEqual([]);
      expect(measured.outcome.labelled).toBeGreaterThan(0);
      expect(measured.outcome.completed).toBe(measured.outcome.labelled);
      expect(providerQuestions).toBeLessThanOrEqual(1024);
      expect(
        (candidates + 3) * size > 1024 || measured.outcome.labelled === size,
      ).toBe(true);
      expect(
        measured.outcome.completed === size || measured.outcome.next !== null,
      ).toBe(true);
      const money = await getDb(db).execute(sql`SELECT
        (SELECT count(*)::int FROM "Expense") AS expenses,
        (SELECT count(*)::int FROM "FinancialTransaction") AS transactions,
        (SELECT count(*)::int FROM "AiUsage") AS usage`);
      expect(money.rows[0]).toMatchObject({
        expenses: 0,
        transactions: candidates,
        usage: 0,
      });
      const pageReport = {
        size,
        database: name,
        setupMs,
        seedMs,
        wallMs,
        cpuMs: (cpu.user + cpu.system) / 1000,
        ...measured,
        providerQuestions,
        queuedQuestions,
        queuedPromptBytes,
        contextFitsCalls,
        contextFitsMs,
        renderedPromptBytes,
        heapBefore,
        peakHeap,
        heapAtDecisionEntry,
        heapAfterGc,
        phases,
        queryShapes: [...querySources.entries()].sort((a, b) => b[1] - a[1]),
        money: money.rows[0],
        importCreated: Boolean(recorded.batchId),
      };
      const replayStart = performance.now();
      let completed = measured.outcome.completed;
      let replayPages = 0;
      let reused = 0;
      while (completed < size) {
        if (replayPages++ >= 10)
          throw new Error("Synthetic replay did not converge");
        const beforeResume = providerQuestions;
        const resumed = await labelStatementSuggestions(db, {
          limit: size,
          runId,
          port,
          ...(adviceMode === "injected" && { spendingAdvice }),
        });
        expect(resumed.failed).toEqual([]);
        expect(providerQuestions - beforeResume).toBeLessThanOrEqual(1024);
        completed += resumed.completed;
        reused += resumed.labels.reused;
      }
      const callsBeforeRepeat = providerQuestions;
      const repeated = await labelStatementSuggestions(db, {
        limit: size,
        runId,
        port,
        ...(adviceMode === "injected" && { spendingAdvice }),
      });
      expect(repeated.failed).toEqual([]);
      expect(repeated.labelled).toBe(0);
      expect(repeated.completed).toBe(0);
      expect(providerQuestions).toBe(callsBeforeRepeat);
      const durable = await getDb(db)
        .execute(sql`SELECT count(*)::int AS active,
        count(*) FILTER (WHERE data->>'needsLabel' = 'true' OR data->>'applicationPending' = 'true')::int AS unfinished,
        count(*) FILTER (WHERE data->'labelCheckpoint'->>'revision' = ${STATEMENT_LABEL_REVISION})::int AS checkpoints
        FROM "AssessmentState" WHERE family = ${assessmentFamily.enum.statement_transaction} AND active`);
      expect(durable.rows[0]).toEqual({
        active: size,
        unfinished: 0,
        checkpoints: size,
      });
      const settledMoney = await getDb(db).execute(sql`SELECT
        (SELECT count(*)::int FROM "Expense") AS expenses,
        (SELECT count(*)::int FROM "FinancialTransaction") AS transactions,
        (SELECT count(*)::int FROM "AiUsage") AS usage`);
      expect(settledMoney.rows[0]).toEqual(money.rows[0]);
      reports.push({
        ...pageReport,
        replay: {
          pages: replayPages,
          completed,
          reused,
          providerQuestions,
          extraProviderQuestions:
            providerQuestions - pageReport.providerQuestions,
          wallMs: performance.now() - replayStart,
          repeatedProviderQuestions: providerQuestions - callsBeforeRepeat,
        },
        durable: durable.rows[0],
      });
      writeFileSync(
        resolve(
          output,
          `measurements-${candidates}-${evidenceBytes}-${kind}-${adviceMode}${profiler ? "-profiled" : ""}.json`,
        ),
        JSON.stringify(
          {
            revision: execFileSync(
              "git",
              [
                "-C",
                resolve(import.meta.dirname, "../../../.."),
                "rev-parse",
                "HEAD",
              ],
              { encoding: "utf8" },
            ).trim(),
            node: process.version,
            platform: process.platform,
            arch: process.arch,
            profiled: Boolean(profiler),
            probeHistoriesCleared: true,
            candidates,
            evidenceBytes,
            kind,
            adviceMode,
            reports,
          },
          null,
          2,
        ),
      );
      console.log(
        JSON.stringify({
          size,
          wallMs: Math.round(wallMs),
          queries: measured.queries,
          completed: measured.outcome.completed,
        }),
      );
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      await pool.end();
      await lease.close();
      console.log(`Retained synthetic database: ${name}`);
    }
  },
);
