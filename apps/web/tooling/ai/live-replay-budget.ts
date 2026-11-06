import { createServer } from "node:http";
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
export async function liveReplayBudget() {
  const ledgerPath = process.env.MAIL_REPLAY_BUDGET_FILE;
  const catalogPath = process.env.MAIL_REPLAY_PRICING_FILE;
  if (
    !ledgerPath ||
    !catalogPath ||
    process.env.MAIL_REPLAY_PLAN_AS_PAID === "1"
  )
    throw new Error(
      "Live replay requires a budget ledger and official pricing snapshot; paid replay is disabled",
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
    if (ledger.stopped || ledger.outstandingUsd > 0)
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
    >();
    const settled = new Set<string>();
    let readUsage: (() => Promise<Usage[]>) | undefined;
    const save = () => {
      writeFileSync(
        `${ledgerPath}.tmp`,
        `${JSON.stringify(ledger, null, 2)}\n`,
      );
      renameSync(`${ledgerPath}.tmp`, ledgerPath);
    };
    function stop(message: string): never {
      ledger.stopped = true;
      save();
      throw new Error(message);
    }
    async function reconcile() {
      if (!readUsage) throw new Error("No active replay case");
      const rows = await readUsage();
      for (const [id, reservation] of pending) {
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
            );
          if (input.action === "refused") {
            const receipt = pending.get(input.id);
            if (!receipt) stop("Refused call has no reservation");
            receipt.refused = true;
            return { id: input.id };
          }
          if (ledger.stopped) throw new Error("Replay allowance stopped");
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
          if (
            ledger.accountedUsd + ledger.outstandingUsd + quote.maxCostUsd >
            ledger.limitUsd
          )
            throw pending.size
              ? new PendingReceipts(
                  "Waiting for physical-call receipts before another full-window reservation",
                )
              : new Error(
                  "Full-window reservation cannot fit the remaining replay allowance",
                );
          const id = `synthetic-eval:${crypto.randomUUID()}`;
          pending.set(id, {
            model: input.model,
            maxCostUsd: quote.maxCostUsd,
            refused: false,
          });
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
    };
    return {
      begin(read: () => Promise<Usage[]>) {
        if (
          readUsage ||
          ledger.stopped ||
          ledger.outstandingUsd > 0 ||
          ledger.accountedUsd >= ledger.limitUsd
        )
          throw new Error("Replay allowance cannot admit another case");
        readUsage = read;
        return { agent: vars, gateway: vars };
      },
      async finish() {
        await serial(async () => {
          await reconcile();
          if (pending.size)
            stop(
              "Missing physical-call receipts; replay allowance stopped with reservations retained",
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
