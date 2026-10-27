import type { ActorContext } from "@cubby/schemas/context";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import type { OperationDisposition } from "@cubby/schemas/entity-integrity";
import type {
  FinancialTransactionId,
  LedgerPartyId,
  LedgerTransferId,
  LedgerTransferShortcode,
} from "@cubby/schemas/identifiers";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import type {
  LedgerSourceClaimOut,
  LedgerTransferCreateInput,
  LedgerTransferUpdateData,
} from "@cubby/schemas/ledger-transfer";
import { rawLedgerTransferOut } from "@cubby/schemas/ledger-transfer-raw-read";
import { cents } from "@cubby/shared";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database, DrizzleTransaction } from "~/server/db";
import type { IncomingEdgePolicy } from "~/server/db/entity-incoming-edges";
import {
  buildPartialUpdateValues,
  notDeleted,
  withTransaction,
} from "~/server/db/helpers";
import {
  financialAccount,
  financialTransaction,
  ledgerTransfer,
} from "~/server/db/schema";
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
import { createAppError } from "~/server/errors/app-error";
import { logAuditEntry } from "~/server/generic/audit-log/repo/audit-log";
import { listScaffold } from "~/server/generic/list/repo/list";
import {
  resolveAllOrThrow,
  resolveOrThrow,
} from "~/server/generic/shortcode/repo/shortcode-resolver";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

const LEDGER_TRANSFER_DELETE_EDGE_POLICY = {
  "FinancialTransaction.ledgerTransferId": {
    code: "clear-evidence-link",
    effect: "detach",
    description:
      "Evidence transactions remain after their transfer is removed.",
  },
  "LedgerSourceClaim.ledgerTransferId": {
    code: "soft-delete-source-claims",
    effect: "soft-delete",
    description: "Transfer-owned normalized claims are retired.",
  },
} as const satisfies IncomingEdgePolicy<"ledgerTransfer", OperationDisposition>;

// oxlint-disable-next-line cubby/no-raw-enum-literal-in-sql -- source, reconciliation and note are JSON property names, not vocabulary values.
const transferSourceClaimsSql = sql<LedgerSourceClaimRow[]>`COALESCE((
  SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
    'source', c.source,
    'sourceKey', c."sourceKey", 'sourceKeyVersion', c."sourceKeyVersion",
    'normalizedEvidence', c."normalizedEvidence", 'reconciliation',
    CASE WHEN c."reconciliationDecision" = 'amounts_match'
      THEN jsonb_build_object('decision', c."reconciliationDecision")
      ELSE jsonb_build_object('decision', c."reconciliationDecision", 'note', c."reconciliationNote") END,
    'targetAmountAtClaim', c."targetAmountAtClaim", 'createdAt', c."createdAt", 'updatedAt', c."updatedAt")) ORDER BY c."createdAt", c.id)
  FROM "LedgerSourceClaim" c
  WHERE c."ledgerTransferId" = "LedgerTransfer".id AND c."deletedAt" IS NULL
), '[]'::jsonb)`;
const transferEvidenceIdsSql = sql<string[]>`COALESCE((
  SELECT jsonb_agg(ft.shortcode ORDER BY ft.amount DESC, ft.shortcode)
  FROM "FinancialTransaction" ft
  WHERE ft."ledgerTransferId" = "LedgerTransfer".id AND ft."deletedAt" IS NULL
), '[]'::jsonb)`;

type LedgerSourceClaimRow = Omit<
  LedgerSourceClaimOut,
  "createdAt" | "updatedAt"
> & {
  createdAt: string;
  updatedAt: string;
};

const partyKind = z.enum(["member", "guest", "household"]);

export const ledgerTransferScaffold = listScaffold(
  "ledgerTransfer",
  ledgerTransfer,
  {
    read: {
      title: sql`(SELECT name FROM "LedgerParty" WHERE id = "LedgerTransfer"."fromPartyId")`,
      // Keys outside the read schema are helper columns the bindings read.
      columns: {
        // includes-deleted: `fromPartyName` is the entity's non-null titleField
        // and `toPartyName` mirrors it; a soft-deleted party's name must not
        // read as SQL NULL into a `z.string()` read schema. The party
        // shortcodes resolve across a soft-deleted party for the same reason.
        fromPartyName: sql<string>`(SELECT name FROM "LedgerParty" WHERE id = "LedgerTransfer"."fromPartyId")`,
        toPartyName: sql<string>`(SELECT name FROM "LedgerParty" WHERE id = "LedgerTransfer"."toPartyId")`,
        sourceClaims: transferSourceClaimsSql,
        evidenceTransactionIds: transferEvidenceIdsSql,
        fromPartyShortcode: sql<string>`(SELECT shortcode FROM "LedgerParty" WHERE id = "LedgerTransfer"."fromPartyId")`,
        toPartyShortcode: sql<string>`(SELECT shortcode FROM "LedgerParty" WHERE id = "LedgerTransfer"."toPartyId")`,
        fromPartyKind: sql<string>`(SELECT kind FROM "LedgerParty" WHERE id = "LedgerTransfer"."fromPartyId")`,
        toPartyKind: sql<string>`(SELECT kind FROM "LedgerParty" WHERE id = "LedgerTransfer"."toPartyId")`,
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
  },
);

/** Per-update work resolved before the audited column update: see `relations`. */
type LedgerTransferChange = {
  columns: Partial<typeof ledgerTransfer.$inferInsert>;
  parties: { fromPartyId: LedgerPartyId; toPartyId: LedgerPartyId };
  amount: number;
  evidence: readonly FinancialTransactionId[];
  sourceClaims: LedgerTransferUpdateData["sourceClaims"];
};

const crud = createEntityCrud({
  table: ledgerTransfer,
  entity: "ledgerTransfer",
  scaffold: ledgerTransferScaffold,
  output: rawLedgerTransferOut,
  toUpdate: (change: LedgerTransferChange) =>
    buildPartialUpdateValues({ ...change.columns, ...change.parties }),
  auditUpdateFields: [...entityFieldModels.ledgerTransfer.audit],
  // Source claims and evidence links live in child tables but are audited as
  // fields: the diff reads them before and after they are rewritten.
  relations: {
    read: async (tx, id) => {
      const [row] = await tx
        .select({
          sourceClaims: transferSourceClaimsSql,
          evidenceTransactionIds: transferEvidenceIdsSql,
        })
        .from(ledgerTransfer)
        .where(eq(ledgerTransfer.id, id));
      return row ?? {};
    },
    write: async (tx, id, change) => {
      await replaceEvidence(
        tx,
        { id, ...change.parties, amount: change.amount },
        change.evidence,
      );
      if (change.sourceClaims !== undefined)
        await replaceLedgerSourceClaims(
          tx,
          { ledgerTransferId: id, targetAmount: change.amount },
          change.sourceClaims ?? [],
        );
    },
  },
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
  bookingLineCount: sql<number>`(SELECT count(*)::int FROM "Expense" booked_expense WHERE booked_expense."bookingTransactionCode" = "FinancialTransaction".shortcode AND booked_expense."deletedAt" IS NULL)`,
  allocationCount: sql<number>`(
        SELECT count(*)::int FROM "FinancialTransactionAllocation" allocation
        WHERE allocation."transactionId" = "FinancialTransaction".id
          AND allocation."deletedAt" IS NULL
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

async function assertEvidenceSet(
  tx: DrizzleTransaction,
  transfer: {
    id: LedgerTransferId;
    fromPartyId: LedgerPartyId;
    toPartyId: LedgerPartyId;
    amount: number;
  },
  transactionIds: readonly FinancialTransactionId[],
) {
  if (transactionIds.length === 0) return;
  const rows = await tx
    .select({
      id: financialTransaction.id,
      accountId: financialTransaction.accountId,
      ledgerTransferId: financialTransaction.ledgerTransferId,
      amount: financialTransaction.amount,
      ledgerPartyId: financialAccount.ledgerPartyId,
      ...transferEvidenceLegFields,
    })
    .from(financialTransaction)
    .innerJoin(
      financialAccount,
      eq(financialTransaction.accountId, financialAccount.id),
    )
    .where(
      and(
        inArray(financialTransaction.id, [...transactionIds]),
        notDeleted(financialTransaction),
        notDeleted(financialAccount),
      ),
    )
    .for("update");
  if (rows.length !== transactionIds.length)
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "Transfer evidence must name live financial transactions.",
    );
  if (
    rows.some(
      (row) =>
        transferEvidenceLegProblem(row) !== null ||
        cents(Math.abs(row.amount)) !== cents(transfer.amount),
    )
  )
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "Transfer evidence must have observed, pending, or posted status, be unallocated, have no live booked Expenses, and match the transfer amount. Review a booked spending conversion before attaching transfer evidence.",
    );
  if (
    rows.some(
      (row) => row.ledgerTransferId && row.ledgerTransferId !== transfer.id,
    )
  )
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "A financial transaction can evidence only one ledger transfer.",
    );
  if (
    rows.some(
      (row) => row.amount > 0 && row.ledgerPartyId !== transfer.fromPartyId,
    ) ||
    rows.some(
      (row) => row.amount < 0 && row.ledgerPartyId !== transfer.toPartyId,
    )
  )
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "Each evidence transaction account must map to its transfer endpoint party.",
    );
  if (rows.length === 2 && rows[0]!.amount > 0 === rows[1]!.amount > 0)
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "Two-sided transfer evidence requires one positive and one negative transaction.",
    );
  if (rows.length === 2 && rows[0]!.accountId === rows[1]!.accountId)
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "Two-sided transfer evidence must use distinct financial accounts.",
    );
}

async function replaceEvidence(
  tx: DrizzleTransaction,
  transfer: {
    id: LedgerTransferId;
    fromPartyId: LedgerPartyId;
    toPartyId: LedgerPartyId;
    amount: number;
  },
  ids: readonly FinancialTransactionId[],
) {
  await assertEvidenceSet(tx, transfer, ids);
  await tx
    .update(financialTransaction)
    .set({ ledgerTransferId: null })
    .where(
      and(
        eq(financialTransaction.ledgerTransferId, transfer.id),
        notDeleted(financialTransaction),
      ),
    );
  if (ids.length)
    await tx
      .update(financialTransaction)
      .set({ ledgerTransferId: transfer.id })
      .where(
        and(
          inArray(financialTransaction.id, [...ids]),
          notDeleted(financialTransaction),
        ),
      );
}

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
    const id = await withTransaction(db, async (tx) => {
      const parties = await resolvePartyIds(tx, data);
      const { sourceClaims, evidenceTransactionIds, ...columns } = data;
      const created = await insertWithShortcode(tx, "ledgerTransfer", {
        ...columns,
        ...parties,
      });
      const evidence = evidenceTransactionIds
        ? await resolveAllOrThrow(
            tx,
            "financialTransaction",
            evidenceTransactionIds,
          )
        : [];
      await replaceLedgerSourceClaims(
        tx,
        { ledgerTransferId: created.id, targetAmount: data.amount },
        sourceClaims ?? [],
      );
      await replaceEvidence(
        tx,
        { id: created.id, ...parties, amount: data.amount },
        evidence,
      );
      await logAuditEntry(tx, actor, {
        entityKind: "ledgerTransfer",
        entityId: created.id,
        action: "create",
      });
      return created.id;
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
    await withTransaction(db, async (tx) => {
      const [locked] = await tx
        .select({
          id: ledgerTransfer.id,
          fromPartyId: ledgerTransfer.fromPartyId,
          toPartyId: ledgerTransfer.toPartyId,
        })
        .from(ledgerTransfer)
        .where(and(eq(ledgerTransfer.id, id), notDeleted(ledgerTransfer)))
        .for("update")
        .limit(1);
      if (!locked)
        throw createAppError(
          "LEDGER_TRANSFER_NOT_FOUND",
          `Ledger transfer not found: ${shortcode}`,
        );
      const before = await crud.getByIDOrNull(tx, id);
      if (!before)
        throw createAppError(
          "LEDGER_TRANSFER_NOT_FOUND",
          `Ledger transfer not found: ${shortcode}`,
        );
      await assertExplicitSourceClaimsForAmountChange(
        tx,
        { ledgerTransferId: id },
        before.amount,
        data.amount ?? before.amount,
        data.sourceClaims,
      );
      const parties =
        data.fromPartyId === undefined && data.toPartyId === undefined
          ? { fromPartyId: locked.fromPartyId, toPartyId: locked.toPartyId }
          : await resolvePartyIds(tx, {
              fromPartyId: data.fromPartyId ?? before.fromPartyId,
              toPartyId: data.toPartyId ?? before.toPartyId,
            });
      const amount = data.amount ?? before.amount;
      // Party shortcodes are resolved into `parties` above; the columns carry ids.
      const {
        sourceClaims,
        evidenceTransactionIds,
        fromPartyId: _fromParty,
        toPartyId: _toParty,
        ...columnData
      } = data;
      const evidence =
        evidenceTransactionIds === undefined
          ? await tx
              .select({ id: financialTransaction.id })
              .from(financialTransaction)
              .where(
                and(
                  eq(financialTransaction.ledgerTransferId, id),
                  notDeleted(financialTransaction),
                ),
              )
              .then((rows) => rows.map((row) => row.id))
          : await resolveAllOrThrow(
              tx,
              "financialTransaction",
              evidenceTransactionIds ?? [],
            );
      await crud.update(
        tx,
        id,
        { columns: columnData, parties, amount, evidence, sourceClaims },
        actor,
        async () => undefined,
      );
    });
    return readOutput({ entityId: id });
  },
});

export const ledgerTransferRepository = defineRepository("ledgerTransfer", {
  lifecycle: { delete: LEDGER_TRANSFER_DELETE_EDGE_POLICY },
  scaffold: ledgerTransferScaffold,
  create: asActor(createLedgerTransfer),
  update: asActor(updateLedgerTransfer),
});
