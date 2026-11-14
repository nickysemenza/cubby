import {
  financialTransactionCreateInput,
  financialTransactionKind,
  type FinancialTransactionCreateInput,
} from "@cubby/schemas/financial-transaction";
import { minorToMoney, moneyToMinor } from "@cubby/shared";
import { sql } from "drizzle-orm";

import { shiftPlainDate } from "~/lib/household-date";
import { textArrayParam } from "~/server/db/helpers/array-param";
import { notDeleted } from "~/server/db/helpers/predicates";
import { manualEntry, recordKey } from "~/server/db/kernel-schema";
import {
  financialAccount,
  financialTransaction,
  ledgerParty,
  sourceOccurrence,
  sourceTransactionRecord,
  vendor,
} from "~/server/db/schema";
import {
  POSTING_WINDOW_DAYS,
  withinPostingDateWindow,
} from "~/server/domains/financial-transaction/policy/settlement-window";
import { mergeBankEvents } from "~/server/domains/financial-transaction/repo/bank-merge";
import {
  statementEffectiveMovement,
  statementLoanInput,
} from "~/server/domains/transaction-import/policy/statement-effective-movement";
import {
  statementTransactionKind,
  decideStatementKind,
  kindAgreed,
  ownAccountNamed,
} from "~/server/domains/transaction-import/policy/statement-transaction-kind";
import {
  occurrenceEvidence,
  statementEvidence,
} from "~/server/domains/transaction-import/repo/statement-evidence";
import {
  defineReconciler,
  defineReadIndex,
  policyRemoval,
  recordSubject,
  source,
  writes,
} from "~/server/kernel/api";
import type { Pure } from "~/server/kernel/api";
import { recordIdentity } from "~/server/kernel/keys";

import { manualTransactionEvidence } from "./manual-evidence";
import {
  transactionCandidates,
  acceptedOccurrences,
} from "./money-read-indexes";

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
    remove: policyRemoval("financialTransaction"),
    discovers: (row) => [{ kind: "purchaseEvent", key: row.id }],
  },
);

import {
  STATEMENT_TRANSACTION_KIND_FEATURE,
  STATEMENT_COUNTERPARTY_FEATURE,
} from "~/server/ai/policy/features";

import type { statementAsks } from "../service/purchase-asks";

const manualHistory = defineReadIndex(manualEntry, {
  name: "manualTransaction.accountMerchant",
  values: (row) => {
    const p = row.payload;
    return row.entity === "financialTransaction" &&
      p &&
      typeof p === "object" &&
      !Array.isArray(p) &&
      typeof p.accountId === "string" &&
      typeof p.merchant === "string"
      ? [`${p.accountId}:${p.merchant.trim().toLowerCase()}`]
      : [];
  },
  where: (
    values,
  ) => sql`EXISTS (SELECT 1 FROM jsonb_to_recordset(${JSON.stringify(values.map((value) => ({ account: value.split(":")[0], merchant: value.slice(value.indexOf(":") + 1) })))}::jsonb) wanted(account text,merchant text)
    WHERE ${manualEntry.entity}=${"financialTransaction"} AND ${manualEntry.payload}->>'accountId'=wanted.account AND lower(trim(${manualEntry.payload}->>'merchant'))=wanted.merchant)`,
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
  candidates: (typeof financialTransaction.$inferSelect)[];
  history: { id: string; kind: string | null }[];
  /** Another bank event attaches, or another live occurrence accepts, this scope's transaction. */
  shared: boolean;
};

/** A member's decisions on the record's own fields still apply during a gap. */
const retained = (c: Pure) => {
  for (const key of c.existing(bankTransactionWrites)) {
    const id = c.recordId(bankTransactionWrites, key);
    const decided = id
      ? [...c.assignments(recordSubject("financialTransaction", id))].filter(
          ([field]) => bankTransactionWrites.columns.includes(field),
        )
      : [];
    if (key.startsWith("accepted:") || !decided.length) {
      c.retire(bankTransactionWrites, key, "keep");
      continue;
    }
    const values: Parameters<Pure["record"]>[2] = {};
    const provenance: Record<string, string> = {};
    for (const [field, decision] of decided) {
      const value = decision.kind === "none" ? null : decision.value;
      values[field] =
        typeof value === "string" && field === "accountId"
          ? c.reference("financialAccount", value)
          : typeof value === "string" && field === "spendingCategoryId"
            ? c.reference("spendingCategory", value)
            : typeof value === "string" && field === "amount"
              ? BigInt(value)
              : value;
      provenance[field] = decision.id;
    }
    c.record(bankTransactionWrites, key, values, { provenance });
  }
  return c.done();
};

export function createBankEvent({
  statementKindAsk,
  counterpartyAsk,
  choiceRequest,
  choiceAnswer,
}: typeof statementAsks) {
  // oxlint-disable-next-line complexity -- movement, kind voting and counterparty checks must agree before booking.
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
    const amount =
      movement?.effectiveAmountMinor ?? moneyToMinor(manual!.amount);
    const rule = observation
      ? statementTransactionKind({
          amountMinor: amount,
          sourceCategory: observation.sourceCategory,
          rawDescription: observation.rawDescription,
          accountKind: resolved.identity.kind,
        })
      : null;
    let kind = manual?.kind ?? rule?.kind ?? "other";
    if (observation && !kindAssigned) {
      const question = {
        descriptor: observation.rawDescription,
        merchant: observation.merchant,
        category: observation.sourceCategory,
        date: observation.statementDate,
        amount: minorToMoney(amount),
        status: observation.providerStatus,
        accountKind: resolved.identity.kind,
      };
      const answer = c.answer(
        statementKindAsk,
        choiceRequest(
          STATEMENT_TRANSACTION_KIND_FEATURE,
          JSON.stringify(question),
        ),
      );
      const counterpartyAnswer = c.answer(
        counterpartyAsk,
        choiceRequest(STATEMENT_COUNTERPARTY_FEATURE, JSON.stringify(question)),
      );
      const label =
        answer.status === "answered"
          ? choiceAnswer(
              answer.output,
              STATEMENT_TRANSACTION_KIND_FEATURE.choices,
            )
          : null;
      const party =
        counterpartyAnswer.status === "answered"
          ? choiceAnswer(
              counterpartyAnswer.output,
              STATEMENT_COUNTERPARTY_FEATURE.choices,
            )
          : null;
      const resolvedHistory = input.history.flatMap((row) => {
        const id =
          c.reference("financialTransaction", row.id) ??
          c.reference(
            "financialTransaction",
            recordIdentity(
              { kind: "bankEvent", key: `manual:${row.id}` },
              bankTransactionWrites.name,
              "transaction",
            ),
          );
        return id ? [{ ...row, id }] : [];
      });
      const history = resolvedHistory
        .filter((row) => row.id !== input.occurrence?.acceptedTransactionId)
        .map(
          (row) =>
            c.decision(
              "assignment",
              recordSubject("financialTransaction", row.id),
              "kind",
            )?.value ?? row.kind,
        )
        .filter((value) => financialTransactionKind.safeParse(value).success);
      const historyKinds = [...new Set(history)];
      const businessHistory = resolvedHistory.some((row) => {
        const advice = c.decision(
          "assignment",
          `purchaseEvent:${row.id}`,
          "advice",
        )?.value;
        return (
          advice &&
          typeof advice === "object" &&
          !Array.isArray(advice) &&
          advice.counterparty === "business"
        );
      });
      const own = input.accounts.map((account) => ({
        id: account.id,
        kind: account.identity.kind,
        names: [
          account.name,
          account.vendorName ?? "",
          ...(account.vendorAliases ?? []),
          ...account.sourceAliases.map((alias) => alias.alias),
        ],
        ledgerPartyId: account.ledgerPartyId,
      }));
      const transfer = ownAccountNamed(
        `${observation.rawDescription ?? ""} ${observation.merchant ?? ""}`,
        own.find((row) => row.id === resolved.id)!,
        own,
      );
      const decision = decideStatementKind({
        amountMinor: amount,
        votes: {
          rule: rule?.kindSource === "rule" ? rule.kind : null,
          label: financialTransactionKind.safeParse(label).success
            ? financialTransactionKind.parse(label)
            : null,
          history:
            historyKinds.length > 1
              ? "mixed"
              : historyKinds.length
                ? financialTransactionKind.parse(historyKinds[0])
                : null,
        },
        counterparty: {
          label: party === "person" || party === "business" ? party : null,
          history: businessHistory ? "business" : null,
          storedValue: resolved.identity.kind === "stored_value",
        },
        transfer,
        descriptor: observation,
      });
      kind = decision.kind;
      if (
        !label ||
        !kindAgreed(
          {
            ...decision,
            rawDescription: observation.rawDescription,
            merchant: observation.merchant,
          },
          transfer,
        )
      ) {
        c.gap.decision(
          `the statement transaction kind (${kind}); the votes and counterparty require review`,
        );
        return null;
      }
    }
    const values = {
      accountId: resolved.id,
      amount,
      kind,
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

  const bankEvent = defineReconciler<BankInput>({
    scope: "bankEvent",
    lane: "money",
    version: 1,
    reads: [
      source.evidence(occurrenceEvidence),
      source.evidence(statementEvidence),
      source.evidence(manualTransactionEvidence),
      source.table(manualEntry, ["entity", "payload"], [manualHistory]),
      source.table(
        financialTransaction,
        [
          "accountId",
          "amount",
          "kind",
          "merchant",
          "transactionDate",
          "postedDate",
          "deletedAt",
        ],
        [transactionCandidates],
      ),
      source.table(
        sourceOccurrence,
        [
          "currentObservationId",
          "accountId",
          "reviewState",
          "disposition",
          "withdrawnAt",
          "acceptedTransactionId",
          "supersededByOccurrenceId",
        ],
        [acceptedOccurrences],
      ),
      source.table(financialAccount, [
        "identity",
        "providerVendorId",
        "sourceAliases",
        "ledgerPartyId",
        "deletedAt",
      ]),
      source.table(ledgerParty, ["kind", "deletedAt"]),
      source.table(vendor, ["name", "aliases", "deletedAt"]),
      source.table(recordKey, ["scopeKind", "scopeKey", "entity", "entityId"]),
    ],
    writes: [bankTransactionWrites],
    asks: [statementKindAsk, counterpartyAsk],
    async load(reads, keys) {
      const [accountRows, parties, owned] = await Promise.all([
        reads.select(financialAccount, [], notDeleted(financialAccount)),
        reads.select(ledgerParty, [], notDeleted(ledgerParty)),
        // A scope's own RecordKey changes only through its own apply.
        reads.select(
          recordKey,
          [],
          sql`${recordKey.scopeKind}='bankEvent' AND ${recordKey.entity}=${"financialTransaction"} AND ${recordKey.scopeKey}=ANY(${textArrayParam(keys)})`,
        ),
      ]);
      const ownIds = [...new Set(owned.map((row) => row.entityId))];
      const [sharing, accepting] = ownIds.length
        ? await Promise.all([
            reads.select(
              recordKey,
              ownIds.map((id) => `record:financialTransaction:${id}`),
              sql`${recordKey.scopeKind}='bankEvent' AND ${recordKey.entity}=${"financialTransaction"} AND ${recordKey.entityId}=ANY(${textArrayParam(ownIds)}::uuid[])`,
            ),
            reads.lookup(sourceOccurrence, acceptedOccurrences, ownIds),
          ])
        : [[], []];
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
            const observationsForScope =
              observations.get(`occurrence:${key}`) ?? [];
            const current = observationsForScope.find(
              (row) => row.id === occurrence?.currentObservationId,
            );
            const dates = current
              ? Array.from(
                  { length: POSTING_WINDOW_DAYS * 2 + 1 },
                  (_, index) =>
                    shiftPlainDate(
                      current.statementDate,
                      index - POSTING_WINDOW_DAYS,
                    ),
                )
              : [];
            const candidates = current
              ? await scoped.lookup(
                  financialTransaction,
                  transactionCandidates,
                  accounts.flatMap((account) =>
                    dates.flatMap((date) => [
                      `${account.id}:${current.providerAmount}:${date}`,
                      `${account.id}:${-current.providerAmount}:${date}`,
                    ]),
                  ),
                )
              : [];
            const past = current?.merchant
              ? await scoped.lookup(
                  manualEntry,
                  manualHistory,
                  accounts.flatMap((account) =>
                    [account.id, account.shortcode].map(
                      (id) => `${id}:${current.merchant!.trim().toLowerCase()}`,
                    ),
                  ),
                )
              : [];
            const history = past.flatMap((row) => {
              const saved = row.payload;
              return saved &&
                typeof saved === "object" &&
                !Array.isArray(saved) &&
                typeof saved.kind === "string"
                ? [{ id: row.id, kind: saved.kind }]
                : [];
            });
            const accepted = await scoped.lookup(
              sourceOccurrence,
              acceptedOccurrences,
              candidates.map((row) => row.id),
            );
            const own = owned.find((row) => row.scopeKey === key)?.entityId;
            return [
              key,
              {
                key,
                occurrence,
                observations: observations.get(`occurrence:${key}`) ?? [],
                manual: manuals.get(`manual:${manualId}`)?.[0] ?? null,
                accounts,
                history,
                shared:
                  !!own &&
                  (sharing.some(
                    (row) => row.entityId === own && row.scopeKey !== key,
                  ) ||
                    accepting.some(
                      (row) =>
                        row.acceptedTransactionId === own &&
                        row.id !== key &&
                        !row.deletedAt &&
                        !row.withdrawnAt &&
                        !row.supersededByOccurrenceId,
                    )),
                candidates: candidates.filter(
                  (row) =>
                    !accepted.some(
                      (owner) =>
                        owner.acceptedTransactionId === row.id &&
                        !owner.deletedAt,
                    ),
                ),
              },
            ] as const;
          }),
        ),
      );
    },
    // oxlint-disable-next-line complexity -- bank identity, evidence and assignment refusals form one atomic money plan.
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
        // A confirmed withdrawal or supersession removes the transaction this
        // scope created, and with it its generated booking, unless another
        // bank event shares it or a member decision holds it.
        const decided =
          !!existing &&
          (c.assignments(record).size > 0 ||
            [...c.assignments(`purchaseEvent:${existing}`).keys()].some(
              (field) => field !== "book",
            ));
        if (
          existing &&
          naturalKey === "transaction" &&
          !owner.deletedAt &&
          owner.disposition !== "ignored" &&
          !input.shared &&
          !decided
        ) {
          c.retire(bankTransactionWrites, naturalKey, "remove");
          return c.done();
        }
        if (existing && !input.shared)
          c.gap.unsupported(
            "accepted transaction evidence is withdrawn or out of scope",
          );
        return retained(c);
      }
      if (owner && owner.reviewState !== "ready") {
        c.gap.decision(
          "the source occurrence identity and current observation",
        );
        return retained(c);
      }
      if (owner?.acceptedTransactionId && !existing) {
        const accepted = c.reference(
          "financialTransaction",
          owner.acceptedTransactionId,
        );
        if (!accepted) {
          c.gap.decision(
            "the accepted transaction identity cannot be resolved; retain the stored acceptance",
          );
          return retained(c);
        }
        c.attach(bankTransactionWrites, `accepted:${accepted}`, accepted);
        c.emit({ kind: "purchaseEvent", key: accepted });
        return c.done();
      }
      if (naturalKey.startsWith("accepted:")) {
        if (existing) c.emit({ kind: "purchaseEvent", key: existing });
        return retained(c);
      }
      const observation = input.observations.find(
        (row) => row.id === owner?.currentObservationId,
      );
      const manual =
        input.manual && !input.occurrence
          ? financialTransactionCreateInput.parse(input.manual.payload)
          : null;
      const assigned = (field: string) => {
        const decisions = [
          record,
          subject,
          ...(owner ? [recordSubject("sourceOccurrence", owner.id)] : []),
        ].flatMap((identity) => {
          const decision = c.decision("assignment", identity, field);
          return decision ? [decision] : [];
        });
        return (
          decisions.sort(
            (a, b) =>
              b.at.getTime() - a.at.getTime() || b.id.localeCompare(a.id),
          )[0] ?? null
        );
      };
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
      // A member's explicit acceptance covers every value of the transaction
      // it creates; it never authorizes later changes to an existing one.
      const acceptance = c.decision("assignment", subject, "accept");
      if (!existing && acceptance?.value === true)
        for (const field of Object.keys(values))
          provenance[field] ??= acceptance.id;
      if (!existing && owner && !owner.acceptedTransactionId) {
        const date = values.transactionDate ?? values.postedDate;
        const candidates = input.candidates.filter(
          (row) =>
            !row.deletedAt &&
            row.accountId === resolved.id &&
            row.amount === values.amount &&
            date &&
            (row.transactionDate ?? row.postedDate) &&
            withinPostingDateWindow(
              date,
              (row.transactionDate ?? row.postedDate)!,
            ),
        );
        const same = candidates.filter(
          (row) =>
            c.decision(
              "identity",
              subject,
              recordSubject("financialTransaction", row.id),
            )?.kind === "same",
        );
        const unresolved = candidates.filter(
          (row) =>
            c.decision(
              "identity",
              subject,
              recordSubject("financialTransaction", row.id),
            )?.kind !== "distinct",
        );
        if (same.length === 1) {
          c.attach(
            bankTransactionWrites,
            `accepted:${same[0]!.id}`,
            same[0]!.id,
          );
          c.emit({ kind: "purchaseEvent", key: same[0]!.id });
          return c.done();
        }
        if (unresolved.length) {
          c.gap.decision(
            "whether this statement charge and the existing transaction are the same or distinct",
            {
              actions: unresolved.flatMap((row) => [
                {
                  channel: "identity",
                  kind: "same",
                  subject,
                  field: recordSubject("financialTransaction", row.id),
                  label: `Same transaction: ${row.shortcode}`,
                },
                {
                  channel: "identity",
                  kind: "distinct",
                  subject,
                  field: recordSubject("financialTransaction", row.id),
                  label: `Distinct transaction: ${row.shortcode}`,
                },
              ]),
            },
          );
          return retained(c);
        }
      }
      c.record(bankTransactionWrites, naturalKey, values, { provenance });
      return c.done();
    },
  });

  return bankEvent;
}
