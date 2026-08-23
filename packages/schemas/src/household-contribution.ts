import { z } from "zod";
import { plainDate, uniqueBy } from "./base-entity";
import { operationRefusalOut } from "./common";
import {
  expenseShortcode,
  financialAccountShortcode,
  financialTransactionShortcode,
  fundingTransferShortcode,
  personShortcode,
  projectShortcode,
} from "./identifiers";
import { money, wholeCentAmount } from "./money";

export const contributionRoleValues = ["beneficiary", "funder"] as const;
export const contributionRoleSchema = z.enum(contributionRoleValues);
export type ContributionRole = z.infer<typeof contributionRoleSchema>;

export const fundingTransferKindValues = [
  "reimbursement",
  "fund_contribution",
  "household_transfer",
  "internal_account_move",
] as const;
export const fundingTransferKindSchema = z.enum(fundingTransferKindValues);
export type FundingTransferKind = z.infer<typeof fundingTransferKindSchema>;

export const accountPersonRoleValues = [
  "sole_owner",
  "joint_owner",
  "authorized_user",
  "custodian",
] as const;
export const accountPersonRoleSchema = z.enum(accountPersonRoleValues);
export type AccountPersonRole = z.infer<typeof accountPersonRoleSchema>;

export const fundingFundKey = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "expected a lowercase slug");
export type FundingFundKey = z.infer<typeof fundingFundKey>;

export const positiveContributionWeight = z
  .number()
  .int()
  .positive()
  .max(2_147_483_647);

export const fundingPartyRef = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("person"), id: personShortcode }),
  z.object({ kind: z.literal("fund"), key: fundingFundKey }),
]);
export type FundingPartyRef = z.infer<typeof fundingPartyRef>;

const weightedPerson = z.object({
  personId: personShortcode,
  weight: positiveContributionWeight.default(1),
});
type WeightedPersonInput = z.infer<typeof weightedPerson>;

const weightedParty = z.object({
  party: fundingPartyRef,
  weight: positiveContributionWeight.default(1),
});
type WeightedPartyInput = z.infer<typeof weightedParty>;

export const weightedBeneficiaries = z
  .object({
    people: z
      .array(weightedPerson)
      .refine(
        ...uniqueBy<WeightedPersonInput>(
          (row) => row.personId,
          "duplicate beneficiary",
        ),
      ),
    householdWeight: positiveContributionWeight.optional(),
    unattributedWeight: positiveContributionWeight.optional(),
  })
  .refine(
    (value) =>
      value.people.length > 0 ||
      value.householdWeight !== undefined ||
      value.unattributedWeight !== undefined,
    "at least one person, household, or unattributed beneficiary weight is required",
  );
export type WeightedBeneficiaries = z.infer<typeof weightedBeneficiaries>;

export const weightedFunders = z
  .object({
    parties: z
      .array(weightedParty)
      .refine(
        ...uniqueBy<WeightedPartyInput>(
          (row) =>
            row.party.kind === "person"
              ? `person:${row.party.id}`
              : `fund:${row.party.key}`,
          "duplicate funder",
        ),
      ),
    unattributedWeight: positiveContributionWeight.optional(),
  })
  .refine(
    (value) =>
      value.parties.length > 0 || value.unattributedWeight !== undefined,
    "at least one funder or an unattributed weight is required",
  );
export type WeightedFunders = z.infer<typeof weightedFunders>;

const sourceRef = z.object({
  source: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  externalId: z.string().trim().min(1),
});
type SourceRefInput = z.infer<typeof sourceRef>;

const transferEvidence = z.object({
  transactionId: financialTransactionShortcode,
  side: z.enum(["outflow", "inflow"]),
});
type TransferEvidenceInput = z.infer<typeof transferEvidence>;

const accountPersonInput = z.object({
  personId: personShortcode,
  role: accountPersonRoleSchema,
});
type AccountPersonInput = z.infer<typeof accountPersonInput>;

const setExpenseAttributionChange = z.object({
  type: z.literal("set_expense_attribution"),
  expenseIds: z.array(expenseShortcode).min(1).max(50),
  beneficiaries: weightedBeneficiaries.nullable().optional(),
  funders: weightedFunders.nullable().optional(),
});

const claimExpenseSourceChange = z
  .object({
    type: z.literal("claim_expense_source"),
    expenseId: expenseShortcode,
    sourceRef,
    sourceAmount: wholeCentAmount,
    reconciliation: z.discriminatedUnion("decision", [
      z.object({ decision: z.literal("amounts_match") }),
      z.object({
        decision: z.literal("accept_existing_expense"),
        note: z.string().trim().min(1),
      }),
    ]),
  })
  .describe(
    "Durably binds an external row to an Expense. A differing source amount requires an explicit, noted decision to retain the existing Expense cost.",
  );

const upsertFundingFundChange = z.object({
  type: z.literal("upsert_funding_fund"),
  key: fundingFundKey,
  name: z.string().trim().min(1),
  notes: z.string().nullable().optional(),
});

const setAccountFundingChange = z.object({
  type: z.literal("set_account_funding"),
  accountId: financialAccountShortcode,
  fundingParty: fundingPartyRef.nullable(),
  people: z
    .array(accountPersonInput)
    .refine(
      ...uniqueBy<AccountPersonInput>(
        (row) => row.personId,
        "duplicate account person",
      ),
    ),
});

const putFundingTransferChange = z
  .object({
    type: z.literal("put_funding_transfer"),
    transferId: fundingTransferShortcode.optional(),
    from: fundingPartyRef,
    to: fundingPartyRef,
    kind: fundingTransferKindSchema,
    amount: wholeCentAmount.positive(),
    date: plainDate,
    notes: z.string().nullable().optional(),
    sourceRefs: z
      .array(sourceRef)
      .refine(
        ...uniqueBy<SourceRefInput>(
          (row) => `${row.source}\u0000${row.externalId}`,
          "duplicate transfer source reference",
        ),
      ),
    evidence: z
      .array(transferEvidence)
      .max(2)
      .refine(
        ...uniqueBy<TransferEvidenceInput>(
          (row) => row.transactionId,
          "duplicate transfer evidence",
        ),
      )
      .refine(
        ...uniqueBy<TransferEvidenceInput>(
          (row) => row.side,
          "duplicate transfer evidence side",
        ),
      ),
  })
  .superRefine((value, ctx) => {
    const fromKey =
      value.from.kind === "person"
        ? `person:${value.from.id}`
        : `fund:${value.from.key}`;
    const toKey =
      value.to.kind === "person"
        ? `person:${value.to.id}`
        : `fund:${value.to.key}`;
    const sameParty = fromKey === toKey;
    if (sameParty !== (value.kind === "internal_account_move")) {
      ctx.addIssue({
        code: "custom",
        message:
          "internal account moves require the same party; other transfers require distinct parties",
        path: ["kind"],
      });
    }
    if (
      value.kind === "fund_contribution" &&
      !(value.from.kind === "person" && value.to.kind === "fund")
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "fund contributions require a person source and a shared fund destination",
        path: ["kind"],
      });
    }
  });

const deleteFundingTransferChange = z.object({
  type: z.literal("delete_funding_transfer"),
  transferId: fundingTransferShortcode,
});

export const householdLedgerChange = z.discriminatedUnion("type", [
  setExpenseAttributionChange,
  claimExpenseSourceChange,
  upsertFundingFundChange,
  setAccountFundingChange,
  putFundingTransferChange,
  deleteFundingTransferChange,
]);
export type HouseholdLedgerChange = z.infer<typeof householdLedgerChange>;

export const previewHouseholdLedgerChangesInput = z.object({
  changes: z.array(householdLedgerChange).min(1).max(50),
});
export type PreviewHouseholdLedgerChangesInput = z.infer<
  typeof previewHouseholdLedgerChangesInput
>;

export const householdLedgerChangePreviewOut = z.object({
  previewFingerprint: z.string().min(1),
  changes: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      status: z.enum([
        "ready",
        "already_recorded",
        "needs_decision",
        "conflict",
      ]),
      summary: z.string(),
      affectedIds: z.array(z.string()),
    }),
  ),
  refusal: operationRefusalOut.optional(),
});
export type HouseholdLedgerChangePreviewOut = z.infer<
  typeof householdLedgerChangePreviewOut
>;

export const applyHouseholdLedgerChangesInput = z.object({
  previewFingerprint: z.string().min(1),
  idempotencyKey: z.string().trim().min(1).max(200),
  changes: z.array(householdLedgerChange).min(1).max(50),
});
export type ApplyHouseholdLedgerChangesInput = z.infer<
  typeof applyHouseholdLedgerChangesInput
>;

export const applyHouseholdLedgerChangesOut = z.object({
  status: z.enum(["applied", "already_applied", "refused"]),
  previewFingerprint: z.string(),
  changed: z.number().int().nonnegative(),
  transferIds: z.array(fundingTransferShortcode),
  refusal: operationRefusalOut.optional(),
});
export type ApplyHouseholdLedgerChangesOut = z.infer<
  typeof applyHouseholdLedgerChangesOut
>;

const fundingPartyOut = z.object({
  key: z.string(),
  kind: z.enum(["person", "shared_fund", "household", "unattributed"]),
  name: z.string(),
  household: z.boolean(),
});

export const householdContributionLedgerInput = z.object({
  asOf: plainDate.optional(),
});
export type HouseholdContributionLedgerInput = z.infer<
  typeof householdContributionLedgerInput
>;

export const householdContributionLedgerOut = z.object({
  asOf: plainDate,
  parties: z.array(
    z.object({
      party: fundingPartyOut,
      consumed: money,
      initiallyOutlaid: money,
      transfersSent: money,
      transfersReceived: money,
      netContribution: money,
      position: money,
    }),
  ),
  unattributed: z.object({ consumption: money, funding: money }),
  checks: z.object({
    expenseTotal: money,
    consumedTotal: money,
    fundedTotal: money,
    transferNet: money,
    positionNet: money,
  }),
  gaps: z.array(
    z.object({
      code: z.enum([
        "missing_beneficiaries",
        "missing_funders",
        "partial_beneficiaries",
        "partial_funders",
        "shared_account_unmapped",
        "unpriced_expense",
        "transfer_evidence_one_sided",
        "unattributed_transfer_party",
      ]),
      amount: money.optional(),
      targetIds: z.array(z.string()),
    }),
  ),
  gapsTruncated: z.boolean(),
});
export type HouseholdContributionLedgerOut = z.infer<
  typeof householdContributionLedgerOut
>;

export const projectContributionInput = z.object({
  projectId: projectShortcode,
  includeSubprojects: z.boolean().default(true),
});
export type ProjectContributionInput = z.infer<typeof projectContributionInput>;

export const projectContributionOut = z.object({
  projectId: projectShortcode,
  wholeGroupCost: money,
  householdInitialExposure: money,
  guestInitialFunding: money,
  unattributedInitialFunding: money,
  householdConsumed: money,
  people: z.array(
    z.object({
      personId: personShortcode,
      name: z.string(),
      kind: z.enum(["household", "guest"]),
      consumed: money,
    }),
  ),
  funders: z.array(
    z.object({
      party: fundingPartyOut,
      initiallyFunded: money,
    }),
  ),
  gaps: z.array(z.string()),
});
export type ProjectContributionOut = z.infer<typeof projectContributionOut>;

export const suggestFinancialTransferPairsInput = z.object({
  transactionIds: z.array(financialTransactionShortcode).min(1).max(200),
  maxDateDistanceDays: z.number().int().min(0).max(14).default(5),
  maxCandidatesPerTransaction: z.number().int().min(1).max(10).default(3),
});
export type SuggestFinancialTransferPairsInput = z.infer<
  typeof suggestFinancialTransferPairsInput
>;

export const financialTransferPairSuggestionsOut = z.object({
  suggestions: z.array(
    z.object({
      transactionId: financialTransactionShortcode,
      status: z.enum(["proposed", "ambiguous", "no_match"]),
      candidates: z.array(
        z.object({
          transactionId: financialTransactionShortcode,
          amount: money,
          dateDistanceDays: z.number().int().nonnegative(),
          fromAccountId: financialAccountShortcode,
          toAccountId: financialAccountShortcode,
          from: fundingPartyRef.nullable(),
          to: fundingPartyRef.nullable(),
          reasons: z.array(z.string()),
        }),
      ),
    }),
  ),
});
export type FinancialTransferPairSuggestionsOut = z.infer<
  typeof financialTransferPairSuggestionsOut
>;
