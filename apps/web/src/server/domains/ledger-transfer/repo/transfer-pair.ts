import { decisionChannel } from "@cubby/schemas/kernel/stage";
import { sql } from "drizzle-orm";
import { z } from "zod";

import { plainDateDaysBetween, shiftPlainDate } from "~/lib/household-date";
import { entityIdentity } from "~/server/db/entity-identity-schema";
import { textArrayParam } from "~/server/db/helpers/array-param";
import { canonicalUuids } from "~/server/db/helpers/query";
import { decision, manualEntry, recordKey } from "~/server/db/kernel-schema";
import { repositoryQueries } from "~/server/db/repository-access.boundary";
import {
  ledgerTransfer,
  financialTransaction,
  financialAccount,
  ledgerParty,
  expense,
  financialTransactionAllocation,
} from "~/server/db/schema";
import { sqlEnumConstant } from "~/server/db/sql-enum";
import { manualTransactionEvidence } from "~/server/domains/financial-transaction/repo/manual-evidence";
import {
  amountDayValue,
  bookingExpenses,
  transactionAllocations,
  transactionCandidates,
  transferLegs as linkedLegs,
} from "~/server/domains/financial-transaction/repo/money-read-indexes";
import { isTransferPairKind } from "~/server/domains/ledger-transfer/policy/transfer-kind";
import {
  decisionKey,
  defineModule,
  defineReconciler,
  source,
  writes,
  recordSubject,
  type Pure,
} from "~/server/kernel/api";

const transferRecords = writes(
  ledgerTransfer,
  ["fromPartyId", "toPartyId", "amount", "date", "notes"],
  { entity: "ledgerTransfer" },
);
const transferLegs = writes(financialTransaction, ["ledgerTransferId"]);
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
function transferPairCandidates(
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

const transferPair = defineReconciler<Input>({
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
    source.table(
      financialTransaction,
      [
        "accountId",
        "amount",
        "kind",
        "status",
        "transactionDate",
        "postedDate",
        "ledgerTransferId",
        "deletedAt",
      ],
      [transactionCandidates, linkedLegs],
    ),
    source.table(financialAccount, ["ledgerPartyId", "deletedAt"]),
    source.table(ledgerParty, ["deletedAt"]),
    source.table(
      expense,
      ["bookingTransactionCode", "deletedAt"],
      [bookingExpenses],
    ),
    source.table(
      financialTransactionAllocation,
      ["transactionId", "deletedAt"],
      [transactionAllocations],
    ),
    source.table(decision, ["channel", "subject", "field", "value"]),
    source.table(entityIdentity, ["shortcode"]),
  ],
  writes: targets,
  async load(reads, keys) {
    // Every scope reads its own anchor, manual entry, decided legs, candidates
    // and their rows through its own scope, so a batchmate's charge never
    // wakes it. Each phase issues every scope's reads in one tick: they
    // coalesce into one statement per source.
    const subjectOf = (key: string) => `transferPair:${key}`;
    const scopes = keys.map((key) => ({ key, scoped: reads.for(key) }));
    const [manuals, anchors, choices, owned] = await Promise.all([
      Promise.all(
        scopes.map(({ key, scoped }) =>
          scoped.facts(manualTransactionEvidence, [subjectOf(key)]),
        ),
      ),
      Promise.all(
        scopes.map(({ key, scoped }) =>
          scoped.rows(financialTransaction, canonicalUuids([key])),
        ),
      ),
      // Every recorded pair decision names legs, not only the one in force.
      reads.selectEach(
        decision,
        new Map(keys.map((key) => [key, [decisionKey(subjectOf(key))]])),
        sql`${decision.channel} = ${sqlEnumConstant(decisionChannel, decisionChannel.enum.assignment)}
          AND ${decision.field} = 'transactions'
          AND ${decision.subject} = ANY(${textArrayParam(keys.map(subjectOf))})`,
      ),
      // A scope's own RecordKey rows change only through its own publication
      // or a kernel merge, which dirties it.
      reads.prepare([], async (database) =>
        repositoryQueries(database)
          .select({ key: recordKey.scopeKey, id: recordKey.entityId })
          .from(recordKey)
          .where(
            sql`${recordKey.scopeKind} = 'transferPair' AND ${recordKey.scopeKey} = ANY(${textArrayParam(keys)})`,
          ),
      ),
    ]);
    const chosen = keys.map((key) =>
      choices.flatMap((row) =>
        row.subject === subjectOf(key) && Array.isArray(row.value)
          ? row.value.filter(
              (value): value is string => typeof value === "string",
            )
          : [],
      ),
    );
    // A decided leg named by shortcode resolves through its Entity row.
    const codes = chosen.map((values) =>
      values.filter((value) => !canonicalUuids([value]).length),
    );
    const named = codes.some((values) => values.length)
      ? await reads.selectEach(
          entityIdentity,
          new Map(
            keys.map((key, index) => [
              key,
              codes[index]!.length ? [decisionKey(subjectOf(key))] : [],
            ]),
          ),
          sql`${entityIdentity.shortcode} = ANY(${textArrayParam(codes.flat())})`,
        )
      : [];
    const ownIds = keys.map((key) =>
      owned.filter((row) => row.key === key).map((row) => row.id),
    );
    const legs = await Promise.all(
      scopes.map(({ key, scoped }, index) => {
        const manualIds = (manuals[index]!.get(subjectOf(key)) ?? []).flatMap(
          (row) => {
            const parsed = seed.safeParse(row.payload);
            return parsed.success ? parsed.data.transactionIds : [];
          },
        );
        const anchor = anchors[index]!.get(key);
        const date = anchor && (anchor.transactionDate ?? anchor.postedDate);
        // Equal minor units within five days of a live anchor, either way.
        const window =
          anchor && !anchor.deletedAt && date
            ? Array.from({ length: 11 }, (_, offset) =>
                amountDayValue(anchor.amount, shiftPlainDate(date, offset - 5)),
              )
            : [];
        const own = new Set(codes[index]);
        return Promise.all([
          scoped.lookup(financialTransaction, transactionCandidates, window),
          scoped.lookup(financialTransaction, linkedLegs, ownIds[index]!),
          scoped.rows(
            financialTransaction,
            canonicalUuids([
              ...manualIds,
              ...chosen[index]!,
              ...named.flatMap((row) =>
                row.shortcode && own.has(row.shortcode) ? [row.id] : [],
              ),
            ]),
          ),
        ]).then(([candidates, linked, decided]) => {
          const transactions = [
            ...(anchor ? [anchor] : []),
            ...candidates.filter((row) => row.amount === -anchor!.amount),
            ...linked,
            ...decided.values(),
          ];
          return [
            ...new Map(transactions.map((row) => [row.id, row])).values(),
          ];
        });
      }),
    );
    const [parties, related] = await Promise.all([
      reads.select(ledgerParty, [], sql`true`),
      Promise.all(
        scopes.map(({ scoped }, index) => {
          const transactions = legs[index]!;
          return Promise.all([
            scoped.rows(
              financialAccount,
              transactions.map((row) => row.accountId),
            ),
            scoped.lookup(
              expense,
              bookingExpenses,
              transactions.map((row) => row.shortcode),
            ),
            scoped.lookup(
              financialTransactionAllocation,
              transactionAllocations,
              transactions.map((row) => row.id),
            ),
            scoped.rows(ledgerTransfer, [
              ...transactions.flatMap((row) =>
                row.ledgerTransferId ? [row.ledgerTransferId] : [],
              ),
              ...ownIds[index]!,
            ]),
          ]);
        }),
      ),
    ]);
    return new Map(
      keys.map((key, index) => {
        const [accounts, expenses, allocations, transfers] = related[index]!;
        return [
          key,
          {
            key,
            transactions: legs[index]!,
            accounts: [...accounts.values()],
            parties,
            expenses,
            allocations,
            transfers: [...transfers.values()],
            manuals: manuals[index]!.get(subjectOf(key)) ?? [],
          },
        ];
      }),
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
      if (!anchor || !isTransferPairKind(anchor.kind)) return keep(c);
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
