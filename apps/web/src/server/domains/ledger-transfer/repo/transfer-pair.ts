import { sql } from "drizzle-orm";
import { z } from "zod";

import { plainDateDaysBetween } from "~/lib/household-date";
import { manualEntry } from "~/server/db/kernel-schema";
import {
  ledgerTransfer,
  financialTransaction,
  financialAccount,
  ledgerParty,
  expense,
  financialTransactionAllocation,
} from "~/server/db/schema";
import { manualTransactionEvidence } from "~/server/domains/financial-transaction/repo/manual-evidence";
import {
  defineModule,
  defineReconciler,
  source,
  writes,
  recordSubject,
  type Pure,
} from "~/server/kernel/api";

export const transferRecords = writes(
  ledgerTransfer,
  ["fromPartyId", "toPartyId", "amount", "date", "notes"],
  { entity: "ledgerTransfer" },
);
export const transferLegs = writes(financialTransaction, ["ledgerTransferId"]);
const targets = [transferRecords, transferLegs];
type Input = {
  key: string;
  transactions: (typeof financialTransaction.$inferSelect)[];
  accounts: (typeof financialAccount.$inferSelect)[];
  parties: (typeof ledgerParty.$inferSelect)[];
  expenses: (typeof expense.$inferSelect)[];
  allocations: (typeof financialTransactionAllocation.$inferSelect)[];
  transfers: (typeof ledgerTransfer.$inferSelect)[];
  manuals: (typeof manualEntry.$inferSelect)[];
};
const seed = z.object({
  transferPair: z.string(),
  values: z.object({
    fromPartyId: z.string(),
    toPartyId: z.string(),
    amount: z.string().regex(/^\d+$/u).transform(BigInt),
    date: z.string(),
    notes: z.string().nullable(),
  }),
  transactionIds: z.array(z.string()),
});
const live = (row: { deletedAt: Date | null }) => !row.deletedAt;
const keep = (c: Pure) => {
  for (const target of targets)
    for (const key of c.existing(target)) c.retire(target, key, "keep");
  return c.done();
};

/** Equal minor units and a bounded date window only retrieve a pair; identity is a decision. */
export function transferPairCandidates(
  rows: Input["transactions"],
  anchor: Input["transactions"][number],
) {
  const date = anchor.transactionDate ?? anchor.postedDate;
  return rows.filter((row) => {
    const otherDate = row.transactionDate ?? row.postedDate;
    return (
      live(row) &&
      row.accountId !== anchor.accountId &&
      row.amount === -anchor.amount &&
      date &&
      otherDate &&
      Math.abs(plainDateDaysBetween(date, otherDate)) <= 5 &&
      ["observed", "pending", "posted"].includes(row.status)
    );
  });
}

export const transferPair = defineReconciler<Input>({
  scope: "transferPair",
  lane: "money",
  version: 1,
  after: ["purchaseEvent"],
  reads: [
    source.evidence(manualTransactionEvidence),
    source.table(ledgerTransfer, [
      "fromPartyId",
      "toPartyId",
      "amount",
      "date",
      "notes",
      "deletedAt",
    ]),
    source.table(financialTransaction, [
      "accountId",
      "amount",
      "kind",
      "status",
      "transactionDate",
      "postedDate",
      "ledgerTransferId",
      "deletedAt",
    ]),
    source.table(financialAccount, ["ledgerPartyId", "deletedAt"]),
    source.table(ledgerParty, ["deletedAt"]),
    source.table(expense, ["bookingTransactionCode", "deletedAt"]),
    source.table(financialTransactionAllocation, [
      "transactionId",
      "deletedAt",
    ]),
  ],
  writes: targets,
  async load(reads, keys) {
    const [
      transactions,
      accounts,
      parties,
      expenses,
      allocations,
      transfers,
      manuals,
    ] = await Promise.all([
      reads.select(financialTransaction, [], sql`true`),
      reads.select(financialAccount, [], sql`true`),
      reads.select(ledgerParty, [], sql`true`),
      reads.select(expense, [], sql`true`),
      reads.select(financialTransactionAllocation, [], sql`true`),
      reads.select(ledgerTransfer, [], sql`true`),
      reads.facts(
        manualTransactionEvidence,
        keys.map((key) => `transferPair:${key}`),
      ),
    ]);
    return new Map(
      keys.map((key) => [
        key,
        {
          key,
          transactions,
          accounts,
          parties,
          expenses,
          allocations,
          transfers,
          manuals: manuals.get(`transferPair:${key}`) ?? [],
        },
      ]),
    );
  },
  reconcile(input, c) {
    const subject = `transferPair:${input.key}`;
    if (c.decision("rejection", subject)?.kind === "reject") return keep(c);
    const manual = input.manuals.flatMap((row) => {
      const parsed = seed.safeParse(row.payload);
      return parsed.success ? [parsed.data] : [];
    })[0];
    const naturalKey = c.existing(transferRecords)[0] ?? "transfer";
    const id = c.identity(transferRecords, naturalKey).id;
    const existing = input.transfers.find((row) => row.id === id && live(row));
    const pairDecision = c.decision("assignment", subject, "transactions");
    const chosenIds =
      pairDecision?.kind === "set" && Array.isArray(pairDecision.value)
        ? pairDecision.value.filter(
            (value): value is string => typeof value === "string",
          )
        : manual?.transactionIds;
    let legs =
      chosenIds
        ?.map((key) =>
          input.transactions.find(
            (row) =>
              row.id === c.reference("financialTransaction", key) && live(row),
          ),
        )
        .filter((row) => row !== undefined) ?? [];
    if (!manual && !chosenIds) {
      const anchor = input.transactions.find(
        (row) => row.id === input.key && live(row),
      );
      if (
        !anchor ||
        !["account_transfer", "credit_card_payment", "loan_payment"].includes(
          anchor.kind,
        )
      )
        return keep(c);
      if (anchor.amount < 0n) {
        for (const row of transferPairCandidates(input.transactions, anchor))
          c.emit({ kind: "transferPair", key: row.id });
        return keep(c);
      }
      const candidates = transferPairCandidates(
        input.transactions,
        anchor,
      ).filter(
        (row) =>
          c.decision(
            "identity",
            subject,
            recordSubject("financialTransaction", row.id),
          )?.kind !== "distinct",
      );
      const accepted = candidates.filter(
        (row) =>
          c.decision(
            "identity",
            subject,
            recordSubject("financialTransaction", row.id),
          )?.kind === "same",
      );
      if (accepted.length !== 1) {
        c.gap.decision("which opposite bank event is the same transfer", {
          actions: candidates.flatMap((row) => [
            {
              channel: "identity" as const,
              kind: "same" as const,
              subject,
              field: recordSubject("financialTransaction", row.id),
              label: "Same transfer",
            },
            {
              channel: "identity" as const,
              kind: "distinct" as const,
              subject,
              field: recordSubject("financialTransaction", row.id),
              label: "Different transfer",
            },
          ]),
        });
        return keep(c);
      }
      legs = [anchor, accepted[0]!];
    }
    if ((chosenIds && legs.length !== chosenIds.length) || legs.length > 2) {
      c.disagree("transfer evidence must name live bank events");
      return keep(c);
    }
    const amounts = legs.map((row) =>
      row.amount < 0n ? -row.amount : row.amount,
    );
    const outflow = legs.find((row) => row.amount > 0n);
    const inflow = legs.find((row) => row.amount < 0n);
    const account = (row: Input["transactions"][number] | undefined) =>
      input.accounts.find(
        (account) => account.id === row?.accountId && live(account),
      );
    const date = legs
      .map((row) => row.transactionDate ?? row.postedDate)
      .filter((row) => row !== null)
      .sort()[0];
    const values =
      manual?.values ??
      (existing
        ? {
            fromPartyId: existing.fromPartyId,
            toPartyId: existing.toPartyId,
            amount: existing.amount,
            date: existing.date,
            notes: existing.notes,
          }
        : {
            fromPartyId: account(outflow)?.ledgerPartyId,
            toPartyId: account(inflow)?.ledgerPartyId,
            amount: amounts[0],
            date,
            notes: null,
          });
    const overrides = c.assignments(recordSubject("ledgerTransfer", id));
    for (const [field, value] of overrides)
      if (transferRecords.columns.includes(field))
        Object.assign(values, {
          [field]:
            field === "amount"
              ? BigInt(String(value.value))
              : value.kind === "none"
                ? null
                : value.value,
        });
    if (
      !values.fromPartyId ||
      !values.toPartyId ||
      !values.date ||
      !values.amount ||
      !input.parties.some(
        (row) => row.id === values.fromPartyId && live(row),
      ) ||
      !input.parties.some((row) => row.id === values.toPartyId && live(row))
    ) {
      c.gap.decision(
        "the transfer date, positive amount and live endpoint parties",
      );
      return keep(c);
    }
    const badLeg = legs.some(
      (row) =>
        !account(row) ||
        !["observed", "pending", "posted"].includes(row.status) ||
        (row.ledgerTransferId && row.ledgerTransferId !== id) ||
        input.allocations.some(
          (allocation) =>
            live(allocation) && allocation.transactionId === row.id,
        ) ||
        input.expenses.some(
          (expense) =>
            live(expense) && expense.bookingTransactionCode === row.shortcode,
        ) ||
        (row.amount > 0n
          ? account(row)?.ledgerPartyId !== values.fromPartyId
          : account(row)?.ledgerPartyId !== values.toPartyId),
    );
    if (
      badLeg ||
      amounts.some((amount) => amount !== values.amount) ||
      (legs.length === 2 &&
        (!outflow || !inflow || outflow.accountId === inflow.accountId))
    ) {
      c.disagree(
        "transfer evidence must conserve the movement, be unused by spending, and agree with its endpoint parties",
      );
      return keep(c);
    }
    c.record(transferRecords, naturalKey, values, {
      authored: !!manual,
      provenance: Object.fromEntries(
        [...overrides].map(([field, choice]) => [field, choice.id]),
      ),
    });
    for (const row of input.transactions.filter(
      (row) =>
        row.ledgerTransferId === id || legs.some((leg) => leg.id === row.id),
    ))
      c.patch(transferLegs, row.id, {
        ledgerTransferId: legs.some((leg) => leg.id === row.id) ? id : null,
      });
    return c.done();
  },
});

export const ledgerTransferKernelModule = defineModule({
  name: "ledgerTransfer",
  entities: ["ledgerTransfer"],
  reconcilers: [transferPair],
  machinery: [
    {
      entity: "ledgerTransfer",
      owning: "transferPair",
      fields: false,
      quality: false,
    },
  ],
});
