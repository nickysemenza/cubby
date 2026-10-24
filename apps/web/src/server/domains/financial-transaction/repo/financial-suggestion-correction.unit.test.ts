import { suggestionCorrectionPlan } from "@cubby/schemas/suggestion-correction";
import { fromPartial } from "@total-typescript/shoehorn";
import { expect, it } from "vitest";

import type { Database } from "~/server/db";

import {
  statementTransactionCorrectionRepair,
  transferPairCorrectionRepair,
} from "./financial-suggestion-correction";

it.each([
  {
    family: "statement_transaction",
    adapter: statementTransactionCorrectionRepair,
  },
  { family: "transfer_pair", adapter: transferPairCorrectionRepair },
])(
  "holds $family corrections without accessing financial state",
  async ({ family, adapter }) => {
    const db = fromPartial<Database>(
      new Proxy(
        {},
        {
          get() {
            throw new Error(
              "Unsupported financial repair accessed the database",
            );
          },
        },
      ),
    );
    const subject =
      family === "statement_transaction"
        ? {
            kind: family,
            entity: "sourceTransactionRecord",
            recordId: crypto.randomUUID(),
            source: "synthetic-bank",
            chargeKey: "synthetic-charge",
          }
        : {
            kind: family,
            entity: "financialAccount",
            recordId: crypto.randomUUID(),
            pairKey: "synthetic-outflow~synthetic-inflow",
          };
    // Explicit null and source-revision-shaped values confer no semantic repair
    // authority, even with retained member application lineage.
    for (const correctedValue of [
      null,
      { kindOverride: "fee", spendingCategoryId: "synthetic-category" },
      { source: "synthetic-bank", amount: null },
    ]) {
      const input = suggestionCorrectionPlan.parse({
        source: {
          feedbackId: crypto.randomUUID(),
          assessmentId: crypto.randomUUID(),
          family,
          subject,
          judgment: {},
          evidence: null,
          correctedValue,
          actorUserId: "synthetic-member",
          applicationFeedbackId: crypto.randomUUID(),
          applicationReceipt: { committed: true },
        },
        target: {
          assessmentId: crypto.randomUUID(),
          family,
          subject,
          judgment: {},
          evidence: null,
          fingerprint: "synthetic-current-evidence",
          status: "applied",
          applicationFeedbackId: crypto.randomUUID(),
          applicationReceipt: { committed: true },
        },
      });
      const before = structuredClone(input);
      expect(await adapter.prepare(db, input)).toMatchObject({
        status: "held",
      });
      expect(input).toEqual(before);
      // There is no serializable ready plan for the coordinator to apply.
      expect(adapter.plan.safeParse(input).success).toBe(false);
    }
  },
);
