import {
  financialAccountShortcode,
  financialTransactionShortcode,
  ledgerPartyShortcode,
} from "@cubby/schemas/identifiers";
import {
  transferPairJudgment,
  type TransferPairLeg,
} from "@cubby/schemas/transfer-pair-suggestion";
import { describe, expect, it } from "vitest";

import type { RunDecision } from "~/contracts/run-detail.contract";

import {
  decisionExplanation,
  decisionFacetCounts,
  presenterFor,
} from "./decision-presenters";
import { runOverview } from "./run-view-model";

const leg = (amount: number): TransferPairLeg => ({
  key: `synthetic:${amount}`,
  origin: "transaction",
  accountId: financialAccountShortcode.parse(
    amount > 0 ? "FAC-4K7M" : "FAC-4K7N",
  ),
  accountName: amount > 0 ? "Synthetic checking" : "Synthetic savings",
  accountKind: "bank_account",
  owner: {
    id: ledgerPartyShortcode.parse("LPY-4K7M"),
    name: "Synthetic member",
  },
  transactionId: financialTransactionShortcode.parse(
    amount > 0 ? "FTX-4K7M" : "FTX-4K7N",
  ),
  charge: null,
  amount,
  date: "2026-10-01",
  merchant: null,
  description: "Synthetic movement",
  kind: "account_transfer",
  signals: { kind: "account_transfer", providerCategory: null },
  movementLabel: {
    choice: "account_move",
    confidence: "high",
    model: "synthetic-model",
  },
  movement: "explicit",
  refs: [],
  overlaps: [],
});
const judgment = transferPairJudgment.parse({
  key: "synthetic-pair",
  outflow: leg(20),
  inflow: leg(-20),
  amount: 20,
  date: "2026-10-01",
  dateGapDays: 0,
  move: "internal",
  competitors: [],
  blockers: [],
  reasons: [],
  clean: true,
  apply: { available: true, reason: null },
});
const row = (patch: Partial<RunDecision> = {}): RunDecision => ({
  id: "00000000-0000-4000-8000-000000000001",
  family: "transfer_pair",
  status: "pending",
  active: true,
  judgment,
  producer: null,
  createdAt: "2026-10-01T12:00:00Z",
  updatedAt: "2026-10-01T12:00:00Z",
  ...patch,
});

describe("Run decision outcomes", () => {
  const presenter = presenterFor("transfer_pair");

  it("separates ready from applied and keeps both success counts visible at zero", () => {
    expect(decisionFacetCounts([], presenter)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "ready_to_apply", count: 0 }),
        expect.objectContaining({ key: "applied", count: 0 }),
      ]),
    );
    expect(presenter.facetOf(row()).key).toBe("ready_to_apply");
    expect(decisionExplanation(row())).toContain("nothing has changed yet");
    expect(presenter.facetOf(row({ status: "applied" })).key).toBe("applied");
    expect(decisionExplanation(row({ status: "applied" }))).toContain(
      "Recorded as a transfer",
    );
    expect(presenter.facetOf(row({ active: false })).key).toBe("not_current");
    expect(
      decisionExplanation(row({ status: "superseded", active: false })),
    ).toContain("replaced");
    expect(
      presenter.facetOf(
        row({
          judgment: {
            ...judgment,
            apply: { available: false, reason: "Synthetic refusal" },
          },
        }),
      ).key,
    ).toBe("needs_review");
  });

  it("explains multiple candidates and unresolved evidence without inventing readiness", () => {
    const evidence = {
      ...judgment,
      clean: false,
      blockers: ["weak_movement", "unresolved_overlap", "cash_leg_missing"],
      reasons: ["Synthetic raw reason"],
      apply: { available: false, reason: "Synthetic refusal" },
    };
    const review = row({ judgment: evidence });
    expect(presenter.facetOf(review).label).toBe("Needs review");
    expect(decisionExplanation(review)).toContain(
      "descriptions do not provide enough evidence",
    );
    expect(decisionExplanation(review)).toContain("same money");
    expect(decisionExplanation(review)).toContain(
      "cash side has not been recorded",
    );
    expect(decisionExplanation(review)).toContain("Apply is unavailable");
    expect(
      presenter.facetOf(
        row({ judgment: { ...evidence, blockers: ["competing_candidates"] } }),
      ).label,
    ).toBe("Multiple possible matches");
  });

  it("counts declared pending work before stored steps exist without treating legacy work as active", () => {
    const overview = runOverview(
      { purpose: "sweep", status: "running", steps: [] },
      undefined,
      Date.now(),
      { kind: "sweep", families: [{ family: "transfer_pair", scope: {} }] },
    );
    expect(overview.steps.map((step) => step.key)).toEqual([
      "transfer_pair_scan",
      "transfer_pair_retire",
      "transfer_pair_label",
    ]);
    expect(overview.current?.phase).toBe("not_started");
    expect(overview.current?.total).toBeNull();
    expect(overview.current?.rate).toBeNull();
  });
});
