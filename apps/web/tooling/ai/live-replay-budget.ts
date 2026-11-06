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
const peerBudget = z.object({
  reservedUsd: z.number().finite().nonnegative(),
  stopped: z.boolean(),
  usage: z.record(
    z.string(),
    z.object({
      requests: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
      models: z.record(z.string(), z.number().int().nonnegative()),
    }),
  ),
});
type Usage = {
  model: string;
  status: string;
  standardCost: number | null;
};

/** One exclusive, host-owned allowance across fresh databases and peer isolates. */
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
  const close = () => {
    closeSync(lock);
    unlinkSync(lockPath);
  };
  try {
    let ledger = ledgerSchema.parse(
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
    const quotes = Object.entries(AI_MODELS).flatMap(([model, declaration]) => {
      const quote =
        declaration.role === "chat"
          ? quoteAiChatRequest(pricing, {
              provider: declaration.provider,
              model,
            })
          : declaration.role === "decision"
            ? quoteAiDecisionRequest(pricing, {
                provider: declaration.provider,
                model,
                questionCount: 1,
              })
            : null;
      return quote
        ? [
            {
              model,
              route:
                declaration.role === "chat"
                  ? declaration.gatewayProvider
                  : "workers-ai",
              maxCostUsd: quote.maxCostUsd,
            },
          ]
        : [];
    });
    const save = () => {
      writeFileSync(
        `${ledgerPath}.tmp`,
        `${JSON.stringify(ledger, null, 2)}\n`,
      );
      renameSync(`${ledgerPath}.tmp`, ledgerPath);
    };
    return {
      close,
      begin() {
        const remaining = ledger.limitUsd - ledger.accountedUsd;
        if (ledger.stopped || ledger.outstandingUsd > 0 || remaining <= 0.1)
          throw new Error("Replay allowance cannot admit another case");
        // Reserve the complete remaining allowance on disk before either peer
        // starts. A crash cannot make a fresh invocation forget its calls.
        ledger.outstandingUsd = remaining;
        save();
        const common = {
          PRICING_CATALOG: catalog,
          EVAL_QUOTES: JSON.stringify(quotes),
        };
        return {
          agent: { ...common, EVAL_BUDGET_USD: String(remaining - 0.1) },
          gateway: { ...common, EVAL_BUDGET_USD: "0.1" },
        };
      },
      finish(rawPeers: unknown[], rows: Usage[]) {
        const peers = rawPeers.map((value) => peerBudget.parse(value));
        const reserved = peers.reduce((sum, peer) => sum + peer.reservedUsd, 0);
        const counts = new Map<string, number>();
        let trustworthy =
          peers.length === 2 && peers.every((peer) => !peer.stopped);
        for (const peer of peers)
          for (const route of Object.values(peer.usage)) {
            trustworthy &&=
              route.failed === 0 &&
              route.requests ===
                Object.values(route.models).reduce(
                  (sum, count) => sum + count,
                  0,
                );
            for (const [model, count] of Object.entries(route.models))
              counts.set(model, (counts.get(model) ?? 0) + count);
          }
        const succeeded = rows.filter((row) => row.status === "succeeded");
        // Release conservative capacity only when every physical transmission
        // has exactly one priced successful receipt. Retries, missing telemetry
        // and failed/unknown writes cannot disappear into a cheaper subtotal.
        trustworthy &&= succeeded.every(
          (row) => row.standardCost !== null && row.standardCost >= 0,
        );
        for (const row of succeeded)
          counts.set(row.model, (counts.get(row.model) ?? 0) - 1);
        trustworthy &&= [...counts.values()].every((count) => count === 0);
        const actual = succeeded.reduce(
          (sum, row) => sum + (row.standardCost ?? 0),
          0,
        );
        trustworthy &&= actual <= reserved && reserved <= ledger.outstandingUsd;
        ledger.accountedUsd += trustworthy ? actual : ledger.outstandingUsd;
        ledger.outstandingUsd = 0;
        ledger.stopped ||=
          !trustworthy || ledger.accountedUsd >= ledger.limitUsd;
        save();
        if (!trustworthy)
          throw new Error(
            "Replay accounting did not reconcile; allowance stopped with its reservation retained",
          );
      },
    };
  } catch (error) {
    close();
    throw error;
  }
}
