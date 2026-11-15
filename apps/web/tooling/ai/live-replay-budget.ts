import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import {
  closeSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { AI_MODELS } from "@cubby/shared/ai/models";
import {
  createAiModelPricing,
  quoteAiChatRequest,
  quoteAiDecisionRequest,
} from "@cubby/shared/ai/pricing";
import { z } from "zod";

const ledgerSchema = z.object({
  limitUsd: z.number().finite().positive(),
  accountedUsd: z.number().finite().nonnegative(),
  outstandingUsd: z.number().finite().nonnegative(),
  stopped: z.boolean(),
  stopReason: z
    .enum(["unknown_outcome", "missing_receipts", "failed_no_usage", "other"])
    .optional(),
  reservations: z
    .array(
      z.object({
        id: z.string(),
        model: z.string(),
        maxCostUsd: z.number().finite().nonnegative(),
        refused: z.boolean(),
      }),
    )
    .default([]),
});
const requestSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("reserve"),
    model: z.string(),
    route: z.enum(["openai", "anthropic", "workers-ai"]),
    count: z.number().int().positive(),
  }),
  z.object({ action: z.literal("failed"), id: z.string() }),
  z.object({ action: z.literal("refused"), id: z.string() }),
]);
type Usage = {
  gatewayLogId?: string | null;
  model: string;
  status: string;
  standardCost: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
};
class PendingReceipts extends Error {}

/** One host-owned allowance for all physical calls, peers, cases and launches. */
export async function liveReplayBudget({
  receiptWaitMs = 5_000,
}: { receiptWaitMs?: number } = {}) {
  const ledgerPath = process.env.MAIL_REPLAY_BUDGET_FILE;
  const catalogPath = process.env.MAIL_REPLAY_PRICING_FILE;
  if (!ledgerPath || !catalogPath)
    throw new Error(
      "Live replay requires a budget ledger and official pricing snapshot",
    );
  const lockPath = `${ledgerPath}.lock`;
  const lock = openSync(lockPath, "wx");
  const unlock = () => {
    closeSync(lock);
    unlinkSync(lockPath);
  };
  try {
    const ledger = ledgerSchema.parse(
      JSON.parse(readFileSync(ledgerPath, "utf8")),
    );
    // A deliberate recovery may keep unknown older calls at their full
    // reservation. It never turns uncertainty into free allowance.
    const carried = new Set(
      process.env.MAIL_REPLAY_CARRY_RESERVATIONS === "1"
        ? ledger.reservations.map((receipt) => receipt.id)
        : [],
    );
    if (
      carried.size &&
      ledger.stopped &&
      (ledger.stopReason === undefined || ledger.stopReason === "other")
    )
      throw new Error(
        "Replay accounting failure requires reconciliation before carrying reservations",
      );
    const held = ledger.reservations.reduce(
      (sum, receipt) => sum + receipt.maxCostUsd,
      0,
    );
    if (
      new Set(ledger.reservations.map((receipt) => receipt.id)).size !==
      ledger.reservations.length
    )
      throw new Error(
        "Replay ledger contains duplicate reservation identities",
      );
    if (
      Math.abs(held - ledger.outstandingUsd) >
      Number.EPSILON * Math.max(1, held)
    )
      throw new Error("Replay reservations do not match outstanding allowance");
    if (ledger.accountedUsd + held > ledger.limitUsd + Number.EPSILON)
      throw new Error("Replay allowance is already exceeded");
    if (
      carried.size === 0 &&
      (ledger.stopped ||
        ledger.outstandingUsd > 0 ||
        ledger.reservations.length > 0)
    )
      throw new Error(
        "Reconcile the stopped or outstanding replay allowance before another transmission",
      );
    const catalog = readFileSync(catalogPath, "utf8");
    const pricing = await createAiModelPricing({
      fetch: async () => new Response(catalog),
      onError: () => {},
    }).current();
    if (!pricing)
      throw new Error("Official replay pricing snapshot is unreadable");
    const pending = new Map<
      string,
      { model: string; maxCostUsd: number; refused: boolean }
    >(ledger.reservations.map(({ id, ...receipt }) => [id, receipt]));
    const activePending = () =>
      [...pending.keys()].filter((id) => !carried.has(id));
    const caseReceipts = new Set<string>();
    const settled = new Set<string>();
    let readUsage: ((receiptIds: string[]) => Promise<Usage[]>) | undefined;
    let accepting = false;
    const save = () => {
      // Preserve the physical identity even when runtime shutdown loses its SQL receipt.
      ledger.reservations = [...pending].map(([id, receipt]) => ({
        id,
        ...receipt,
      }));
      ledger.outstandingUsd = ledger.reservations.reduce(
        (sum, receipt) => sum + receipt.maxCostUsd,
        0,
      );
      writeFileSync(
        `${ledgerPath}.tmp`,
        `${JSON.stringify(ledger, null, 2)}\n`,
      );
      renameSync(`${ledgerPath}.tmp`, ledgerPath);
    };
    function stop(
      message: string,
      reason: NonNullable<z.infer<typeof ledgerSchema>["stopReason"]> = "other",
    ): never {
      ledger.stopped = true;
      ledger.stopReason = reason;
      save();
      throw new Error(message);
    }
    async function reconcile() {
      if (!readUsage) throw new Error("No active replay case");
      const rows = await readUsage([...caseReceipts]);
      for (const [id, reservation] of pending) {
        if (carried.has(id)) continue;
        const matches = rows.filter((row) => row.gatewayLogId === id);
        if (!matches.length) continue;
        const row = matches[0];
        if (
          matches.length === 1 &&
          row &&
          row.model === reservation.model &&
          reservation.refused &&
          row.status === "failed" &&
          (row.standardCost === null || row.standardCost === 0) &&
          row.inputTokens === null &&
          row.outputTokens === null &&
          row.cacheReadTokens === null &&
          row.cacheWriteTokens === null
        ) {
          ledger.outstandingUsd = Math.max(
            0,
            ledger.outstandingUsd - reservation.maxCostUsd,
          );
          pending.delete(id);
          settled.add(id);
          continue;
        }
        if (
          matches.length !== 1 ||
          !row ||
          row.model !== reservation.model ||
          row.status !== "succeeded" ||
          row.standardCost === null ||
          !Number.isFinite(row.standardCost) ||
          row.standardCost < 0 ||
          row.standardCost > reservation.maxCostUsd
        )
          stop(
            "Unpriced or ambiguous physical-call usage; replay allowance stopped",
            matches.length === 1 &&
              row?.model === reservation.model &&
              row.status === "failed" &&
              (row.standardCost === null || row.standardCost === 0) &&
              row.inputTokens === null &&
              row.outputTokens === null &&
              row.cacheReadTokens === null &&
              row.cacheWriteTokens === null
              ? "failed_no_usage"
              : "other",
          );
        ledger.accountedUsd += row.standardCost;
        ledger.outstandingUsd = Math.max(
          0,
          ledger.outstandingUsd - reservation.maxCostUsd,
        );
        pending.delete(id);
        settled.add(id);
      }
      for (const row of rows)
        if (
          row.status === "succeeded" &&
          row.standardCost !== 0 &&
          (!row.gatewayLogId ||
            (!settled.has(row.gatewayLogId) && !pending.has(row.gatewayLogId)))
        )
          stop(
            "Stored usage has no physical reservation; replay allowance stopped",
          );
      if (
        ledger.accountedUsd + ledger.outstandingUsd >
        ledger.limitUsd + Number.EPSILON
      )
        stop("Replay allowance exceeded");
      save();
    }
    // Serialize PostgreSQL reconciliation with admission before any peer can
    // transmit. Two async peer requests must not reserve the same capacity.
    let tail = Promise.resolve();
    function serial<T>(effect: () => Promise<T>): Promise<T> {
      const result = tail.then(effect);
      tail = result.then(
        () => {},
        () => {},
      );
      return result;
    }
    const token = crypto.randomUUID();
    const server = createServer(async (request, response) => {
      try {
        if (request.method !== "POST" || request.url !== `/${token}`) {
          response.writeHead(404).end();
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const chunk of request) {
          const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += value.length;
          if (bytes > 4096)
            throw new Error("Oversized replay admission request");
          chunks.push(value);
        }
        const input = requestSchema.parse(
          JSON.parse(Buffer.concat(chunks).toString("utf8")),
        );
        const result = await serial(async () => {
          if (input.action === "failed")
            stop(
              `Unknown physical-call outcome ${input.id}; reservation retained`,
              "unknown_outcome",
            );
          if (input.action === "refused") {
            const receipt = pending.get(input.id);
            if (!receipt) stop("Refused call has no reservation");
            receipt.refused = true;
            save();
            return { id: input.id };
          }
          if (ledger.stopped || !accepting)
            throw new Error("Replay allowance stopped");
          await reconcile();
          const declaration = Object.entries(AI_MODELS).find(
            ([model]) => model === input.model,
          )?.[1];
          const quote =
            declaration?.role === "chat" &&
            declaration.gatewayProvider === input.route
              ? quoteAiChatRequest(pricing, {
                  provider: declaration.provider,
                  model: input.model,
                })
              : declaration?.role === "decision" && input.route === "workers-ai"
                ? quoteAiDecisionRequest(pricing, {
                    provider: declaration.provider,
                    model: input.model,
                    questionCount: input.count,
                  })
                : null;
          if (!quote || (declaration?.role === "chat" && input.count !== 1))
            stop("Physical call has no conservative catalog quote");
          const fits = () =>
            ledger.accountedUsd + ledger.outstandingUsd + quote.maxCostUsd <=
            ledger.limitUsd;
          const refusedPending = () =>
            [...pending].some(
              ([id, receipt]) => !carried.has(id) && receipt.refused,
            );
          if (!fits() && refusedPending()) {
            // Refusal telemetry is queued. Let that exact no-usage SQL receipt
            // arrive before deciding whether the next funding step can fit.
            const deadline = Date.now() + receiptWaitMs;
            while (!fits() && refusedPending() && Date.now() < deadline) {
              await delay(Math.min(100, receiptWaitMs));
              await reconcile();
            }
            if (!fits() && refusedPending())
              stop(
                "Refused physical-call receipt did not arrive; reservation retained",
              );
          }
          if (!fits())
            throw activePending().length
              ? new PendingReceipts(
                  "Waiting for physical-call receipts before another full-window reservation",
                )
              : new Error(
                  "Full-window reservation cannot fit the remaining replay allowance",
                );
          if (ledger.stopped || !accepting)
            throw new Error("Replay allowance stopped");
          const id = `synthetic-eval:${crypto.randomUUID()}`;
          pending.set(id, {
            model: input.model,
            maxCostUsd: quote.maxCostUsd,
            refused: false,
          });
          caseReceipts.add(id);
          ledger.outstandingUsd += quote.maxCostUsd;
          save();
          return { id };
        });
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify(result));
      } catch (error) {
        response
          .writeHead(error instanceof PendingReceipts ? 429 : 403, {
            "content-type": "application/json",
          })
          .end(JSON.stringify({ error: String(error) }));
      }
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Replay admission server has no TCP address");
    const vars = {
      PRICING_CATALOG: catalog,
      EVAL_BUDGET_URL: `http://127.0.0.1:${address.port}/${token}`,
      ...(process.env.MAIL_REPLAY_ALLOW_PAID === "1" && { ALLOW_PAID: "1" }),
    };
    if (carried.size) {
      ledger.stopped = false;
      delete ledger.stopReason;
      save();
    }
    return {
      receiptIds: () => [...caseReceipts],
      begin(read: (receiptIds: string[]) => Promise<Usage[]>) {
        if (
          readUsage ||
          ledger.stopped ||
          activePending().length > 0 ||
          ledger.accountedUsd >= ledger.limitUsd
        )
          throw new Error("Replay allowance cannot admit another case");
        readUsage = read;
        caseReceipts.clear();
        accepting = true;
        return { agent: vars, gateway: vars };
      },
      assertActive() {
        if (ledger.stopped)
          throw new Error(
            "Replay allowance stopped; inspect retained reservations before continuing",
          );
      },
      async finish() {
        // Close admission before reconciling, so background audit work cannot
        // reserve a new physical call after the final receipt snapshot.
        accepting = false;
        await serial(async () => {
          await reconcile();
          const deadline = Date.now() + receiptWaitMs;
          while (
            activePending().length &&
            !ledger.stopped &&
            Date.now() < deadline
          ) {
            await delay(Math.min(100, receiptWaitMs));
            await reconcile();
          }
          if (activePending().length)
            stop(
              "Missing physical-call receipts; replay allowance stopped with reservations retained",
              "missing_receipts",
            );
          if (ledger.stopped) throw new Error("Replay allowance stopped");
          readUsage = undefined;
        });
      },
      async close() {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        unlock();
      },
    };
  } catch (error) {
    unlock();
    throw error;
  }
}
