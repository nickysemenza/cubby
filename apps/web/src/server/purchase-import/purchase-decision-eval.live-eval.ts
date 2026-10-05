/* eslint-disable anti-slop/no-object-parameters -- Harness peer fixtures are JSON wire payloads posted unchanged. */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { sleep } from "@cubby/shared/retry";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { createWorkerdHarness } from "tooling/purchase-agent-workerd-harness";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  expense,
  financialTransaction,
  financialTransactionAllocation,
  orderMail,
  orderMailEvent,
  product,
  purchase,
  run as runTable,
  runFinding,
  runProgress,
} from "~/server/db/schema";
import { getDb, withTransaction } from "~/server/repo/database-helpers";
import {
  createProductFixture,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import {
  type EvalCandidate,
  evalCandidates,
  evalCostUsd,
  evalUsageReport,
  evalWebRoot,
  liveEvalModelWorker,
} from "./agent-eval-live-support";
import { learnPurchaseProductExternalId } from "./external-id-learning";
import { startOrderMailImport } from "./gmail/import";
import { authorizePurchaseAgent } from "./purchase-agent-workerd.fixtures";
import {
  DECISION_MERCHANT,
  type DecisionCase,
  decisionExtraction,
  decisionMailBody,
  purchaseDecisionCases,
} from "./purchase-decision-eval.fixtures";
import {
  type ObservedDecision,
  scoreDecision,
  summarizeDecisions,
} from "./purchase-decision-eval.score";

/**
 * Live purchase-coordinator decision eval. Opt-in and billed: the real
 * import-run agent runs in workerd against an isolated database, its model calls go to
 * Cubby's AI Gateway as each candidate, and the web Worker's extractor and
 * audit answer deterministically (`purchase-import-test-gateway.ts`) so only
 * the coordinator's decisions vary. Run with
 * `pnpm --dir apps/web eval:purchase-decisions`; never part of CI.
 */
const candidates = evalCandidates("gpt-6-luna:high,gpt-6-sol:high");
const caseFilter = process.env.PURCHASE_EVAL_CASES?.split(",");
const cases = purchaseDecisionCases.filter(
  (decision) => !caseFilter || caseFilter.includes(decision.name),
);
const repeats = Number(process.env.AGENT_EVAL_REPEATS ?? "1");
const RUN_TIMEOUT_MS = 8 * 60_000;
const SETTLED = new Set(["completed", "needs_review", "failed"]);

/** The fixture input for a catalog entry; an explicit undefined would
 * override the fixture's own manufacturer and model defaults. */
function catalogProductInput(entry: {
  name: string;
  manufacturer?: string;
  model?: string;
}) {
  const defaults = makeProductInput({ name: entry.name });
  return makeProductInput({
    name: entry.name,
    manufacturer: entry.manufacturer ?? defaults.manufacturer,
    model: entry.model ?? defaults.model,
  });
}

describe("purchase coordinator decision eval", () => {
  const ctx = withTestDb();

  it(
    "scores candidate models on synthetic purchase decisions",
    async () => {
      const party = await insertWithShortcode(ctx.db, "ledgerParty", {
        name: "Synthetic decision member",
        kind: "member",
        userId: ctx.actor.userId,
      });
      const card = await insertWithShortcode(ctx.db, "financialAccount", {
        name: "Synthetic decision card",
        identity: { kind: "credit_card", issuer: null, network: "visa" },
        ledgerPartyId: party.id,
      });
      await authorizePurchaseAgent(ctx.db, ctx.actor.userId);
      for (const key of [
        "WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE",
        "WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE_CACHED",
      ])
        process.env[key] = ctx.databaseUrl;
      const harness = createWorkerdHarness(
        ctx.databaseUrl,
        liveEvalModelWorker(),
      );
      await harness.listen();
      // The web Worker is the harness's primary Worker, so `listen()`'s URL
      // serves the app; the agent queue is reached through its producer.
      const queue = harness.getWorker("cubby-queue-producer");
      const model = harness.getWorker("cubby-test-model");
      const gateway = harness.getWorker("cubby-test-gateway");
      const configure = (worker: typeof model, target: string, body: object) =>
        worker.fetch(target, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });

      // Every run gets its own Vendor, catalog, and charges, so one
      // candidate's writes never become another's evidence.
      const runCase = async (decision: DecisionCase, choice: EvalCandidate) => {
        const vendor = await insertWithShortcode(ctx.db, "vendor", {
          name: `${DECISION_MERCHANT} ${crypto.randomUUID()}`,
        });
        const catalog = new Map<string, string>();
        for (const entry of decision.catalog) {
          const created = await createProductFixture(
            ctx.db,
            catalogProductInput(entry),
            ctx.actor,
          );
          catalog.set(created.entityId, entry.key);
          if (entry.sku) {
            const sku = entry.sku;
            await withTransaction(ctx.db, (tx) =>
              learnPurchaseProductExternalId(tx, {
                productId: created.entityId,
                source: `vendor-${vendor.id}`,
                kind: "retailer_sku",
                externalId: sku,
              }),
            );
          }
        }
        if (decision.priorOrder)
          await insertWithShortcode(ctx.db, "purchase", {
            vendorId: vendor.id,
            orderId: decision.priorOrder.orderId,
            date: decision.priorOrder.date,
            displayLabel: DECISION_MERCHANT,
            statedTotal: decision.priorOrder.total,
          });
        const charges = new Map<
          typeof financialTransaction.$inferSelect.id,
          string
        >();
        for (const charge of decision.charges ?? []) {
          const row = await insertWithShortcode(
            ctx.db,
            "financialTransaction",
            {
              accountId: card.id,
              kind: "purchase",
              status: "posted",
              amount: charge.amount,
              merchant: DECISION_MERCHANT.toUpperCase(),
              transactionDate: charge.date,
              postedDate: charge.date,
            },
          );
          charges.set(row.id, charge.key);
        }
        const [mail] = await getDb(ctx.db)
          .insert(orderMail)
          .values({
            ledgerPartyId: party.id,
            vendorId: vendor.id,
            messageId: `decision-${decision.name}-${crypto.randomUUID()}`,
            sender: "orders@outfitters.example.test",
            subject: `Order ${decision.orderId} confirmed`,
            receivedAt: new Date("2026-09-25T12:00:00Z"),
            rawChecksum: "d".repeat(64),
            content: {
              snippet: null,
              bodyHtml: null,
              bodyText: decisionMailBody(decision),
            },
          })
          .returning();
        if (!mail) throw new Error("Missing decision mail");
        const [event] = await getDb(ctx.db)
          .insert(orderMailEvent)
          .values({
            orderMailId: mail.id,
            event: "placed",
            orderId: decision.orderId,
            currency: "USD",
            sourceKey: `decision:${mail.id}`,
          })
          .returning();
        if (!event) throw new Error("Missing decision mail event");
        await configure(gateway, "https://gateway.test/configure", {
          extractions: [
            { match: decision.orderId, output: decisionExtraction(decision) },
          ],
        });
        await configure(model, "https://model.test/configure", choice);
        const sent: unknown[] = [];
        const started = await startOrderMailImport(
          ctx.db,
          { eventId: event.id, evidenceChecksum: mail.rawChecksum },
          ctx.actor,
          { send: async (value) => void sent.push(value) },
        );
        const [run] = await getDb(ctx.db)
          .select({ id: runTable.id })
          .from(runTable)
          .where(eq(runTable.shortcode, started.runId));
        if (!run) throw new Error("Missing decision run");
        const startedAt = new Date();
        // An unanswered dispatch never starts the agent; unchecked, it showed
        // only as an eight-minute timeout with no model calls.
        const dispatched = await queue.fetch("https://queue.test/dispatch", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(sent[0]),
        });
        if (!dispatched.ok)
          throw new Error(
            `Dispatch failed (${dispatched.status}): ${await dispatched.text()}`,
          );

        let status = "timeout";
        const deadline = Date.now() + RUN_TIMEOUT_MS;
        while (Date.now() < deadline) {
          const [row] = await getDb(ctx.db)
            .select({ status: runTable.status })
            .from(runTable)
            .where(eq(runTable.id, run.id));
          const [waiting] = await getDb(ctx.db)
            .select({ id: runProgress.id })
            .from(runProgress)
            .where(
              and(
                eq(runProgress.runId, run.id),
                eq(runProgress.awaitingApproval, true),
              ),
            )
            .limit(1);
          if (row && SETTLED.has(row.status)) {
            status = row.status;
            break;
          }
          // A generic mutation awaiting a human is a stop, not an answer.
          if (waiting) {
            status = "awaiting_approval";
            break;
          }
          await sleep(1_000);
        }
        const wallMs = Date.now() - startedAt.getTime();
        const usage = evalUsageReport.parse(
          await (await model.fetch("https://model.test/usage")).json(),
        );

        const purchases = await getDb(ctx.db)
          .select({ id: purchase.id })
          .from(purchase)
          .where(
            and(
              eq(purchase.vendorId, vendor.id),
              eq(purchase.orderId, decision.orderId),
            ),
          );
        const purchaseIds = purchases.map(({ id }) => id);
        const expenses = purchaseIds.length
          ? await getDb(ctx.db)
              .select({
                name: expense.name,
                cost: expense.cost,
                date: expense.date,
                productId: expense.productId,
              })
              .from(expense)
              .where(
                and(
                  inArray(expense.purchaseId, purchaseIds),
                  gte(expense.createdAt, startedAt),
                ),
              )
          : [];
        const allocations = purchaseIds.length
          ? await getDb(ctx.db)
              .select({
                transactionId: financialTransactionAllocation.transactionId,
                amount: financialTransactionAllocation.amount,
              })
              .from(financialTransactionAllocation)
              .where(
                inArray(financialTransactionAllocation.purchaseId, purchaseIds),
              )
          : [];
        // Not scored: why a run stopped, so a miss can be diagnosed.
        const findings = await getDb(ctx.db)
          .select({ kind: runFinding.kind, summary: runFinding.summary })
          .from(runFinding)
          .where(eq(runFinding.runId, run.id));
        // Charges share the member and merchant across runs; retire this
        // run's so a leftover never becomes a later run's competing charge.
        if (charges.size)
          await getDb(ctx.db)
            .update(financialTransaction)
            .set({ deletedAt: new Date() })
            .where(inArray(financialTransaction.id, [...charges.keys()]));
        const observed: ObservedDecision = {
          status,
          lines: expenses.map((row) => {
            const product = row.productId
              ? catalog.get(row.productId)
              : undefined;
            return {
              key:
                decision.lines.find((entry) => entry.title === row.name)?.key ??
                row.name,
              // A blank cost never matches the evidence: it scores as wrong.
              cost: row.cost ?? Number.NaN,
              date: row.date,
              product: !row.productId
                ? { kind: "none" as const }
                : product
                  ? { kind: "existing" as const, product }
                  : { kind: "new" as const },
            };
          }),
          allocations: allocations.map((row) => ({
            transaction: charges.get(row.transactionId) ?? row.transactionId,
            amount: row.amount,
          })),
        };
        return {
          case: decision.name,
          focus: decision.focus,
          model: choice.model,
          effort: choice.effort,
          wallMs,
          usage,
          costUsd: evalCostUsd(choice.model, usage),
          observed,
          findings,
          ...scoreDecision(decision.expected, observed),
        };
      };

      const outDir = path.join(
        evalWebRoot,
        "../../artifacts/purchase-decision-eval",
        new Date().toISOString().replace(/[:.]/gu, "-"),
      );
      mkdirSync(outDir, { recursive: true });
      const results: Awaited<ReturnType<typeof runCase>>[] = [];
      for (const choice of candidates)
        for (const decision of cases)
          for (let attempt = 0; attempt < repeats; attempt += 1) {
            // The database clock, not the host's: a container clock can lag
            // the host by seconds, which would miss this run's rows.
            const [clock] = await getDb(ctx.db)
              .select({ now: sql<string>`clock_timestamp()` })
              .from(sql`(select 1) as clock`);
            if (!clock) throw new Error("Database clock was unavailable");
            const caseStartedAt = new Date(clock.now);
            results.push(await runCase(decision, choice));
            // Product names are unique per manufacturer: retire every Product
            // this run seeded or created so the next run can reuse the same
            // catalog and order titles without colliding or matching it.
            await getDb(ctx.db)
              .update(product)
              .set({
                name: sql`${product.name} || ' ~' || ${product.id}`,
                deletedAt: new Date(),
              })
              .where(gte(product.createdAt, caseStartedAt));
            // A retained Purchase keeps its printed payment evidence, which
            // would compete with a later case's charge for settlement.
            await getDb(ctx.db)
              .update(purchase)
              .set({ deletedAt: new Date() })
              .where(gte(purchase.createdAt, caseStartedAt));
            // Written per run so a later failure keeps finished results.
            writeFileSync(
              path.join(outDir, "results.jsonl"),
              `${results.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
            );
          }

      const summary = candidates.map((choice) => ({
        candidate: `${choice.model}:${choice.effort}`,
        ...summarizeDecisions(
          results.filter(
            (result) =>
              result.model === choice.model && result.effort === choice.effort,
          ),
        ),
      }));
      writeFileSync(
        path.join(outDir, "report.json"),
        `${JSON.stringify({ summary, results }, null, 2)}\n`,
      );
      const table = [
        "| Candidate | Correct | Unsafe | Reviewable miss | Wall s | In tok | Out tok | Cost/run |",
        "|---|---|---|---|---|---|---|---|",
        ...summary.map(
          (row) =>
            `| ${row.candidate} | ${row.correct}/${row.runs} | ${row.unsafe} | ${row.reviewableMiss} | ${row.meanWallSeconds.toFixed(0)} | ${Math.round(row.meanInputTokens)} | ${Math.round(row.meanOutputTokens)} | $${row.meanCostUsd.toFixed(3)} |`,
        ),
      ].join("\n");
      writeFileSync(path.join(outDir, "report.md"), `${table}\n`);
      console.log(`[purchase-decision-eval] report: ${outDir}\n${table}`);
      await harness.close();
      expect(results).toHaveLength(candidates.length * cases.length * repeats);
    },
    24 * 60 * 60_000,
  );
});
