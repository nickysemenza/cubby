import {
  financialTransactionCreateInput,
  financialTransactionKind,
  type FinancialTransactionCreateInput,
} from "@cubby/schemas/financial-transaction";
import { statementQuestionSubject } from "@cubby/schemas/statement-answers";
import { minorToMoney, moneyToMinor } from "@cubby/shared";

import { notDeleted } from "~/server/db/helpers/predicates";
import { manualEntry } from "~/server/db/kernel-schema";
import {
  financialAccount,
  financialTransaction,
  ledgerParty,
  sourceOccurrence,
  sourceTransactionRecord,
  vendor,
} from "~/server/db/schema";
import { mergeBankEvents } from "~/server/domains/financial-transaction/repo/bank-merge";
import {
  statementEffectiveMovement,
  statementLoanInput,
} from "~/server/domains/transaction-import/policy/statement-effective-movement";
import { statementTransactionKind } from "~/server/domains/transaction-import/policy/statement-transaction-kind";
import {
  occurrenceEvidence,
  statementEvidence,
} from "~/server/domains/transaction-import/repo/statement-evidence";
import {
  defineAsk,
  defineReconciler,
  recordSubject,
  source,
  writes,
} from "~/server/kernel/api";
import type { Pure } from "~/server/kernel/api";

import { manualTransactionEvidence } from "./manual-evidence";

export const bankTransactionWrites = writes(
  financialTransaction,
  [
    "accountId",
    "kind",
    "status",
    "amount",
    "transactionDate",
    "postedDate",
    "merchant",
    "rawDescription",
    "sourceCategory",
    "notes",
    "spendingCategoryId",
    "itemizationExpectation",
  ],
  {
    entity: "financialTransaction",
    merge: mergeBankEvents,
    discovers: (row) => [{ kind: "purchaseEvent", key: row.id }],
  },
);

/** The retained statement-kind question; this consumer never calls a producer. */
export const statementKindAsk = defineAsk({
  feature: "statement-transaction-kind",
  producer: "model",
  promptVersion: "2026-11-12.1",
  policy: { outputRevision: "financial-transaction-kind.v1" },
  input: statementQuestionSubject,
  output: financialTransactionKind.nullable(),
  label: "the statement transaction kind",
});

type Account = typeof financialAccount.$inferSelect & {
  ledgerParty: typeof ledgerParty.$inferSelect | null;
  vendorName: string | null;
  vendorAliases: string[] | null;
};
type BankInput = {
  key: string;
  occurrence: typeof sourceOccurrence.$inferSelect | null;
  observations: (typeof sourceTransactionRecord.$inferSelect)[];
  manual: typeof manualEntry.$inferSelect | null;
  accounts: Account[];
};

const retained = (c: Pure) => {
  for (const key of c.existing(bankTransactionWrites))
    c.retire(bankTransactionWrites, key, "keep");
  return c.done();
};

function deriveBankValues({
  input,
  observation,
  manual,
  resolved,
  kindAssigned,
  c,
}: {
  input: BankInput;
  observation: typeof sourceTransactionRecord.$inferSelect | undefined;
  manual: FinancialTransactionCreateInput | null;
  resolved: Account;
  kindAssigned: boolean;
  c: Pure;
}) {
  const movement = observation
    ? statementEffectiveMovement({
        providerAmountMinor: observation.providerAmount,
        description: observation.rawDescription,
        merchant: observation.merchant,
        sourceCategory: observation.sourceCategory,
        loan: statementLoanInput(
          {
            source: observation.source,
            account: observation.accountDescriptor,
            providerAccountId: observation.providerAccountId,
          },
          resolved,
          input.accounts,
          input.observations,
        ),
      })
    : null;
  if (movement?.reviewReason) {
    c.gap.decision(movement.reviewReason);
    return null;
  }
  const amount = movement?.effectiveAmountMinor ?? moneyToMinor(manual!.amount);
  const rule = observation
    ? statementTransactionKind({
        amountMinor: amount,
        sourceCategory: observation.sourceCategory,
        rawDescription: observation.rawDescription,
        accountKind: resolved.identity.kind,
      })
    : null;
  const answer =
    observation && !kindAssigned
      ? c.answer(
          statementKindAsk,
          {
            descriptor: observation.rawDescription,
            merchant: observation.merchant,
            category: observation.sourceCategory,
            date: observation.statementDate,
            amount: minorToMoney(amount),
            status: observation.providerStatus,
          },
          { request: false },
        )
      : null;
  const unclassified =
    !manual &&
    rule?.kindSource === "sign" &&
    answer?.status !== "answered" &&
    !kindAssigned;
  if (unclassified) c.gap.answer("the statement transaction kind", "agent");
  const values = {
    accountId: resolved.id,
    amount,
    kind: unclassified
      ? "other"
      : (manual?.kind ??
        (answer?.status === "answered" ? answer.output : null) ??
        rule!.kind),
    status: manual?.status ?? observation?.providerStatus ?? "observed",
    transactionDate:
      manual?.transactionDate ?? observation?.statementDate ?? null,
    postedDate:
      manual?.postedDate ??
      (observation?.providerStatus === "posted"
        ? observation.statementDate
        : null),
    merchant: manual?.merchant ?? observation?.merchant ?? null,
    rawDescription:
      manual?.rawDescription ?? observation?.rawDescription ?? null,
    sourceCategory:
      manual?.sourceCategory ?? observation?.sourceCategory ?? null,
    notes: manual?.notes ?? null,
    spendingCategoryId: null,
    itemizationExpectation: manual?.itemizationExpectation ?? null,
  };
  return values;
}

export const bankEvent = defineReconciler<BankInput>({
  scope: "bankEvent",
  lane: "money",
  version: 1,
  reads: [
    source.evidence(occurrenceEvidence),
    source.evidence(statementEvidence),
    source.evidence(manualTransactionEvidence),
    source.table(sourceOccurrence, [
      "currentObservationId",
      "accountId",
      "reviewState",
      "disposition",
      "withdrawnAt",
      "acceptedTransactionId",
      "supersededByOccurrenceId",
    ]),
    source.table(financialAccount, [
      "identity",
      "providerVendorId",
      "sourceAliases",
      "ledgerPartyId",
      "deletedAt",
    ]),
    source.table(ledgerParty, ["kind", "deletedAt"]),
    source.table(vendor, ["name", "aliases", "deletedAt"]),
  ],
  writes: [bankTransactionWrites],
  asks: [statementKindAsk],
  async load(reads, keys) {
    const [accountRows, parties] = await Promise.all([
      reads.select(financialAccount, [], notDeleted(financialAccount)),
      reads.select(ledgerParty, [], notDeleted(ledgerParty)),
    ]);
    const providers = await reads.rows(
      vendor,
      accountRows.flatMap((account) =>
        account.identity.kind === "loan" && account.providerVendorId
          ? [account.providerVendorId]
          : [],
      ),
    );
    const accounts = accountRows.map((account): Account => ({
      ...account,
      ledgerParty:
        parties.find((party) => party.id === account.ledgerPartyId) ?? null,
      vendorName: providers.get(account.providerVendorId ?? "")?.name ?? null,
      vendorAliases:
        providers.get(account.providerVendorId ?? "")?.aliases ?? null,
    }));
    return new Map(
      await Promise.all(
        keys.map(async (key) => {
          const scoped = reads.for(key);
          const occurrence = key.startsWith("manual:")
            ? null
            : ((await scoped.rows(sourceOccurrence, [key])).get(key) ?? null);
          const manualId = key.startsWith("manual:")
            ? key.slice(7)
            : occurrence?.acceptedTransactionId;
          const [observations, manuals] = await Promise.all([
            scoped.facts(
              statementEvidence,
              occurrence ? [`occurrence:${occurrence.id}`] : [],
            ),
            scoped.facts(
              manualTransactionEvidence,
              manualId ? [`manual:${manualId}`] : [],
            ),
          ]);
          return [
            key,
            {
              key,
              occurrence,
              observations: observations.get(`occurrence:${key}`) ?? [],
              manual: manuals.get(`manual:${manualId}`)?.[0] ?? null,
              accounts,
            },
          ] as const;
        }),
      ),
    );
  },
  reconcile(input, c) {
    const owner = input.occurrence;
    const subject = `bank:${input.key}`;
    const naturalKey = c.existing(bankTransactionWrites)[0] ?? "transaction";
    const existing = c.recordId(bankTransactionWrites, naturalKey);
    const record = existing
      ? recordSubject("financialTransaction", existing)
      : subject;
    if (
      c.decision("rejection", record)?.kind === "reject" ||
      c.decision("rejection", subject)?.kind === "reject"
    )
      return retained(c);
    if (
      owner &&
      (owner.deletedAt ||
        owner.withdrawnAt ||
        owner.supersededByOccurrenceId ||
        owner.disposition === "ignored")
    ) {
      if (existing)
        c.gap.unsupported(
          "accepted transaction evidence is withdrawn or out of scope",
        );
      return retained(c);
    }
    if (owner && owner.reviewState !== "ready") {
      c.gap.decision("the source occurrence identity and current observation");
      return retained(c);
    }
    const observation = input.observations.find(
      (row) => row.id === owner?.currentObservationId,
    );
    const manual =
      input.manual && !input.occurrence
        ? financialTransactionCreateInput.parse(input.manual.payload)
        : null;
    const assigned = (field: string) =>
      c.decision("assignment", record, field) ??
      c.decision("assignment", subject, field) ??
      (owner
        ? c.decision(
            "assignment",
            recordSubject("sourceOccurrence", owner.id),
            field,
          )
        : null);
    const accountDecision = assigned("accountId");
    if (accountDecision?.kind === "none") {
      c.gap.decision("the financial account");
      return retained(c);
    }
    const decidedAccount =
      typeof accountDecision?.value === "string"
        ? c.reference("financialAccount", accountDecision.value)
        : null;
    if (accountDecision?.kind === "set" && !decidedAccount) {
      c.gap.decision("a live financial account for the assignment");
      return retained(c);
    }
    const account =
      input.accounts.find((candidate) => candidate.id === decidedAccount) ??
      input.accounts.find((candidate) => candidate.id === owner?.accountId) ??
      input.accounts.find(
        (candidate) =>
          candidate.id ===
          (manual ? c.reference("financialAccount", manual.accountId) : null),
      );
    const matching = account
      ? [account]
      : input.accounts.filter((candidate) =>
          candidate.sourceAliases.some(
            (alias) =>
              alias.source === owner?.source &&
              (observation?.providerAccountId
                ? alias.externalAccountId === observation.providerAccountId
                : alias.alias.trim().toLowerCase() ===
                  observation?.accountDescriptor.trim().toLowerCase()),
          ),
        );
    const resolved = matching.length === 1 ? matching[0] : null;
    if (!resolved || (!observation && !manual)) {
      c.gap.decision(
        resolved ? "the current source observation" : "the financial account",
        {
          actions: input.accounts.map((account) => ({
            channel: "assignment",
            kind: "set",
            subject,
            field: "accountId",
            value: account.shortcode,
            label: `Use ${account.name}`,
          })),
        },
      );
      return retained(c);
    }
    const values = deriveBankValues({
      input,
      observation,
      manual,
      resolved,
      kindAssigned: assigned("kind") !== null,
      c,
    });
    if (!values) return retained(c);
    const provenance: Record<string, string> = {};
    for (const field of bankTransactionWrites.columns) {
      const decision = assigned(field);
      if (!decision) continue;
      let value = decision.kind === "none" ? null : decision.value;
      if (typeof value === "string" && field === "accountId")
        value = c.reference("financialAccount", value);
      if (typeof value === "string" && field === "spendingCategoryId")
        value = c.reference("spendingCategory", value);
      Object.assign(values, {
        [field]:
          field === "amount" && typeof value === "string"
            ? BigInt(value)
            : value,
      });
      provenance[field] = decision.id;
    }
    c.record(bankTransactionWrites, naturalKey, values, { provenance });
    return c.done();
  },
});
