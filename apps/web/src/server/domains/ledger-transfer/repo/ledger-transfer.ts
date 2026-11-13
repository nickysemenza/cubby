import type { ActorContext } from "@cubby/schemas/context";
import {
  type LedgerTransferCreateInput,
  type LedgerTransferUpdateData,
} from "@cubby/schemas/entities/ledgerTransfer";
import { ledgerTransferRawOut as rawLedgerTransferOut } from "@cubby/schemas/entity-contracts/ledgerTransfer";
import type { LedgerTransferShortcode } from "@cubby/schemas/identifiers";
import { parseEntityId, parseShortcodeFor } from "@cubby/schemas/identifiers";
import type { LedgerSourceClaimOut } from "@cubby/schemas/ledger-transfer";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";

import {
  ledgerTransferRepositoryReadSchema,
  ledgerTransferSchemaBindings,
} from "~/entity/generated/entity-schema-bindings.ledgerTransfer.gen";
import type { Database, DrizzleTransaction } from "~/server/db";
import { minorToDollarsSql } from "~/server/db/computed/money";
import { DECLARED_EDGE_DELETE_POLICIES } from "~/server/db/generated/declared-edges.gen";
import {
  databaseForTransaction,
  notDeleted,
  withTransaction,
} from "~/server/db/helpers";
import { outer, related } from "~/server/db/helpers/related";
import {
  financialAccount,
  financialTransaction,
  ledgerParty,
  ledgerTransfer,
} from "~/server/db/schema";
import { financialEvidenceAmountMinor } from "~/server/domains/financial-transaction/repo/financial-evidence";
import { lockLedgerPartiesForReference } from "~/server/domains/ledger-party/repo/ledger-party-reference";
import {
  assertExplicitSourceClaimsForAmountChange,
  replaceLedgerSourceClaims,
} from "~/server/domains/ledger-party/repo/ledger-source-claim";
import {
  type MutationReceipt,
  defineMutationWriter,
} from "~/server/entity-kernel/repo/repository";
import {
  asActor,
  defineRepository,
} from "~/server/entity-kernel/repo/repository";
import { createEntityCrud } from "~/server/entity-kernel/repo/repository";
import { listScaffold } from "~/server/generic/list/repo/list";
import {
  resolveAllOrThrow,
  resolveOrThrow,
} from "~/server/generic/shortcode/repo/shortcode-resolver";

// oxlint-disable-next-line cubby/no-raw-enum-literal-in-sql -- source, reconciliation and note are JSON property names, not vocabulary values.
const transferSourceClaimsSql = sql<LedgerSourceClaimRow[]>`COALESCE((
  SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
    'source', c.source,
    'sourceKey', c."sourceKey", 'sourceKeyVersion', c."sourceKeyVersion",
    'normalizedEvidence', c."normalizedEvidence", 'reconciliation',
    CASE WHEN c."reconciliationDecision" = 'amounts_match'
      THEN jsonb_build_object('decision', c."reconciliationDecision")
      ELSE jsonb_build_object('decision', c."reconciliationDecision", 'note', c."reconciliationNote") END,
    'targetAmountAtClaim', ${minorToDollarsSql(sql`c."targetAmountMinor"`, "numeric")}, 'createdAt', c."createdAt", 'updatedAt', c."updatedAt")) ORDER BY c."createdAt", c.id)
  FROM "LedgerSourceClaim" c
  WHERE c."ledgerTransferId" = "LedgerTransfer".id AND ${notDeleted("c")}
), '[]'::jsonb)`;
const transferEvidenceIdsSql = sql<string[]>`COALESCE((
  SELECT jsonb_agg(ft.shortcode ORDER BY (${minorToDollarsSql(sql`ft."amountMinor"`, "numeric")}) DESC, ft.shortcode)
  FROM "FinancialTransaction" ft
  WHERE ft."ledgerTransferId" = "LedgerTransfer".id AND ${notDeleted("ft")}
), '[]'::jsonb)`;

type LedgerSourceClaimRow = Omit<
  LedgerSourceClaimOut,
  "createdAt" | "updatedAt"
> & {
  createdAt: string;
  updatedAt: string;
};

// includes-deleted: transfer titles and party references resolve across a
// soft-deleted party (see the read columns below).
const transferParty = (column: typeof ledgerTransfer.fromPartyId) =>
  related(ledgerParty, (party) => eq(party.id, outer(column)), {
    includeDeleted: true,
  });
const fromParty = transferParty(ledgerTransfer.fromPartyId);
const toParty = transferParty(ledgerTransfer.toPartyId);

const partyKind = z.enum(["member", "guest", "household"]);

const ledgerTransferScaffold = listScaffold("ledgerTransfer", ledgerTransfer, {
  readSchema: ledgerTransferRepositoryReadSchema,
  read: {
    title: fromParty.value<string>((party) => party.name),
    // Keys outside the read schema are helper columns the bindings read.
    columns: {
      // includes-deleted: `fromPartyName` is the entity's non-null titleField
      // and `toPartyName` mirrors it; a soft-deleted party's name must not
      // read as SQL NULL into a `z.string()` read schema. The party
      // shortcodes resolve across a soft-deleted party for the same reason.
      fromPartyName: fromParty.value<string>((party) => party.name),
      toPartyName: toParty.value<string>((party) => party.name),
      sourceClaims: transferSourceClaimsSql,
      evidenceTransactionIds: transferEvidenceIdsSql,
      fromPartyShortcode: fromParty.value<string>((party) => party.shortcode),
      toPartyShortcode: toParty.value<string>((party) => party.shortcode),
      fromPartyKind: fromParty.value<string>((party) => party.kind),
      toPartyKind: toParty.value<string>((party) => party.kind),
    },
    bindings: (bind) => [
      bind(
        rawLedgerTransferOut.pick({ fromPartyId: true, toPartyId: true }),
        (row) => ({
          fromPartyId: parseShortcodeFor(
            "ledgerParty",
            z.string().parse(row.fromPartyShortcode),
          ),
          toPartyId: parseShortcodeFor(
            "ledgerParty",
            z.string().parse(row.toPartyShortcode),
          ),
        }),
      ),
      // The aggregate carries claim timestamps as JSON strings.
      bind(rawLedgerTransferOut.pick({ sourceClaims: true }), (row) => ({
        sourceClaims: rawLedgerTransferOut.shape.sourceClaims.parse(
          z
            .array(
              z.looseObject({ createdAt: z.string(), updatedAt: z.string() }),
            )
            .parse(row.sourceClaims)
            .map((claim) => ({
              ...claim,
              createdAt: new Date(claim.createdAt),
              updatedAt: new Date(claim.updatedAt),
            })),
        ),
      })),
      bind(
        rawLedgerTransferOut.pick({ evidenceTransactionIds: true }),
        (row) => ({
          evidenceTransactionIds: z
            .array(z.string())
            .parse(row.evidenceTransactionIds)
            .map((id) => parseShortcodeFor("financialTransaction", id)),
        }),
      ),
      bind(rawLedgerTransferOut.pick({ classification: true }), (row) => {
        const toKind = partyKind.parse(row.toPartyKind);
        const fromKind = partyKind.parse(row.fromPartyKind);
        return {
          classification: rawLedgerTransferOut.shape.classification.parse(
            row.fromPartyId === row.toPartyId
              ? "internal_move"
              : toKind === "household"
                ? "contribution"
                : fromKind === "household"
                  ? "household_distribution"
                  : "reimbursement",
          ),
        };
      }),
    ],
  },
});

const crud = createEntityCrud({
  table: ledgerTransfer,
  entity: "ledgerTransfer",
  scaffold: ledgerTransferScaffold,
  output: rawLedgerTransferOut,
  toUpdate: (data: Partial<typeof ledgerTransfer.$inferInsert>) => data,
  auditUpdateFields: [],
});
/** One live Ledger Transfer by public code, or null. */
export const readLedgerTransfer = crud.getByShortcode;

async function resolvePartyIds(
  tx: DrizzleTransaction,
  input: Pick<LedgerTransferCreateInput, "fromPartyId" | "toPartyId">,
) {
  const [fromParty, toParty] = await lockLedgerPartiesForReference(tx, [
    input.fromPartyId,
    input.toPartyId,
  ]);
  return { fromPartyId: fromParty!.id, toPartyId: toParty!.id };
}

/**
 * Per-leg facts that decide whether a financial transaction may evidence a
 * Ledger Transfer. Select them from `financialTransaction` joined to its
 * `financialAccount`; `transferEvidenceLegProblem` reads them.
 */
export const transferEvidenceLegFields = {
  status: financialTransaction.status,
  accountShortcode: financialAccount.shortcode,
  accountDeletedAt: financialAccount.deletedAt,
  bookingLineCount: sql<number>`(SELECT count(*)::int FROM "Expense" booked_expense WHERE booked_expense."bookingTransactionCode" = "FinancialTransaction".shortcode AND ${notDeleted("booked_expense")})`,
  allocationCount: sql<number>`(
        SELECT count(*)::int FROM "FinancialTransactionAllocation" allocation
        WHERE allocation."transactionId" = "FinancialTransaction".id
          AND ${notDeleted("allocation")}
      )`,
};

type TransferEvidenceLeg = Pick<
  typeof financialTransaction.$inferSelect,
  "status"
> & {
  accountShortcode: string;
  accountDeletedAt: Date | null;
  bookingLineCount: number;
  allocationCount: number;
};

export const transferEvidenceStatuses: readonly TransferEvidenceLeg["status"][] =
  ["observed", "pending", "posted"];

/** Why a leg cannot evidence a transfer, as a clause after its shortcode. */
export const transferEvidenceLegProblem = (
  leg: TransferEvidenceLeg,
): string | null =>
  leg.accountDeletedAt !== null
    ? `is on deleted account ${leg.accountShortcode}`
    : !transferEvidenceStatuses.includes(leg.status)
      ? `is ${leg.status}; only observed, pending, or posted transactions can evidence a transfer`
      : leg.allocationCount > 0
        ? `has ${leg.allocationCount} live allocation(s) to a Purchase; remove them before using it as transfer evidence`
        : leg.bookingLineCount > 0
          ? `has ${leg.bookingLineCount} live booked Expense(s); review the booked spending conversion before using it as transfer evidence`
          : null;

export const createLedgerTransfer = defineMutationWriter({
  entity: "ledgerTransfer",
  read: async (
    receipt: MutationReceipt<"ledgerTransfer">,
    db: Database,
    _data: LedgerTransferCreateInput,
    _actor: ActorContext,
  ) => ({
    output: await crud.getByID(db, receipt.entityId),
    entityId: receipt.entityId,
  }),
  write: async (
    readOutput,
    db: Database,
    data: LedgerTransferCreateInput,
    actor: ActorContext,
  ) => {
    const { createTransferEvent } = await import("./transfer-mutations");
    const id = await withTransaction(db, async (tx) => {
      const parties = await resolvePartyIds(tx, data);
      const evidence = await resolveAllOrThrow(
        tx,
        "financialTransaction",
        data.evidenceTransactionIds ?? [],
      );
      const id = await createTransferEvent(
        databaseForTransaction(tx),
        {
          ...parties,
          amount: financialEvidenceAmountMinor(data.amount),
          date: data.date,
          notes: data.notes,
        },
        evidence,
        actor,
      );
      await replaceLedgerSourceClaims(
        tx,
        {
          ledgerTransferId: parseEntityId("ledgerTransfer", id),
          targetAmount: data.amount,
        },
        data.sourceClaims ?? [],
      );
      return parseEntityId("ledgerTransfer", id);
    });
    return readOutput({ entityId: id });
  },
});

export const updateLedgerTransfer = defineMutationWriter({
  entity: "ledgerTransfer",
  read: async (
    receipt: MutationReceipt<"ledgerTransfer">,
    db: Database,
    _shortcode: LedgerTransferShortcode,
    _data: LedgerTransferUpdateData,
    _actor: ActorContext,
  ) => ({
    output: await crud.getByID(db, receipt.entityId),
    entityId: receipt.entityId,
  }),
  write: async (
    readOutput,
    db: Database,
    shortcode: LedgerTransferShortcode,
    data: LedgerTransferUpdateData,
    actor: ActorContext,
  ) => {
    const id = await resolveOrThrow(db, "ledgerTransfer", shortcode);
    const { updateTransferEvent } = await import("./transfer-mutations");
    await withTransaction(db, async (tx) => {
      const before = await crud.getByID(tx, id);
      await assertExplicitSourceClaimsForAmountChange(
        tx,
        { ledgerTransferId: id },
        before.amount,
        data.amount ?? before.amount,
        data.sourceClaims,
      );
      const {
        sourceClaims,
        evidenceTransactionIds,
        fromPartyId,
        toPartyId,
        amount,
        ...columns
      } = data;
      const parties =
        fromPartyId === undefined && toPartyId === undefined
          ? {}
          : await resolvePartyIds(tx, {
              fromPartyId: fromPartyId ?? before.fromPartyId,
              toPartyId: toPartyId ?? before.toPartyId,
            });
      const evidence =
        evidenceTransactionIds === undefined
          ? undefined
          : await resolveAllOrThrow(
              tx,
              "financialTransaction",
              evidenceTransactionIds ?? [],
            );
      await updateTransferEvent(
        databaseForTransaction(tx),
        id,
        {
          ...columns,
          ...parties,
          ...(amount === undefined
            ? {}
            : { amount: financialEvidenceAmountMinor(amount) }),
        },
        evidence,
        actor,
      );
      if (sourceClaims !== undefined)
        await replaceLedgerSourceClaims(
          tx,
          { ledgerTransferId: id, targetAmount: amount ?? before.amount },
          sourceClaims ?? [],
        );
    });
    return readOutput({ entityId: id });
  },
});

export const ledgerTransferRepository = defineRepository("ledgerTransfer", {
  schemas: ledgerTransferSchemaBindings,
  lifecycle: { delete: DECLARED_EDGE_DELETE_POLICIES.ledgerTransfer },
  scaffold: ledgerTransferScaffold,
  create: asActor(createLedgerTransfer),
  update: asActor(updateLedgerTransfer),
});
