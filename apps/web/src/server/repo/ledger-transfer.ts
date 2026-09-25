import type { ActorContext } from "@cubby/schemas/context";
import type { DataQuality } from "@cubby/schemas/data-quality";
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
  LedgerTransferFilters,
  LedgerTransferOut,
  LedgerTransferUpdateData,
} from "@cubby/schemas/ledger-transfer";
import { ledgerTransferOut } from "@cubby/schemas/ledger-transfer";
import type { PaginationParams, SortParams } from "@cubby/schemas/pagination";
import { and, eq, inArray, sql } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import type { IncomingEdgePolicy } from "~/server/db/entity-incoming-edges";
import {
  financialAccount,
  financialTransaction,
  ledgerTransfer,
} from "~/server/db/schema";
import { entityRepository } from "~/server/entity-kernel/adapter";
import { createAppError } from "~/server/errors/app-error";
import { computeChanges, logAuditEntry } from "~/server/repo/audit-log";
import { loadDataQualities } from "~/server/repo/data-quality";
import {
  buildPartialUpdateValues,
  notDeleted,
  unwrapDb,
  withTransaction,
} from "~/server/repo/database-helpers";
import { createEntityReader } from "~/server/repo/entity-crud-factory";
import { lockLedgerPartiesForReference } from "~/server/repo/ledger-party-reference";
import {
  assertExplicitSourceClaimsForAmountChange,
  replaceLedgerSourceClaims,
} from "~/server/repo/ledger-source-claim";
import { listScaffold } from "~/server/repo/list-scaffold";
import { cents } from "~/server/repo/money";
import {
  resolveAllOrThrow,
  resolveAllPresent,
  resolveOrThrow,
} from "~/server/repo/shortcode-resolver";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

export const LEDGER_TRANSFER_DELETE_EDGE_POLICY = {
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

const columns = {
  id: ledgerTransfer.id,
  shortcode: ledgerTransfer.shortcode,
  fromPartyId: ledgerTransfer.fromPartyId,
  toPartyId: ledgerTransfer.toPartyId,
  // includes-deleted: `fromPartyName` is the entity's non-null titleField and
  // `toPartyName` mirrors it; the `deletedAt IS NULL` filter these used to
  // carry made a soft-deleted party's name read as SQL NULL into a
  // `z.string()` read schema. `fromPartyShortcode`/`toPartyShortcode` below
  // already resolve across a soft-deleted party for the same reason.
  fromPartyName: sql<string>`(SELECT name FROM "LedgerParty" WHERE id = "LedgerTransfer"."fromPartyId")`,
  toPartyName: sql<string>`(SELECT name FROM "LedgerParty" WHERE id = "LedgerTransfer"."toPartyId")`,
  fromPartyShortcode: sql<string>`(SELECT shortcode FROM "LedgerParty" WHERE id = "LedgerTransfer"."fromPartyId")`,
  toPartyShortcode: sql<string>`(SELECT shortcode FROM "LedgerParty" WHERE id = "LedgerTransfer"."toPartyId")`,
  fromPartyKind: sql<
    "member" | "guest" | "household"
  >`(SELECT kind FROM "LedgerParty" WHERE id = "LedgerTransfer"."fromPartyId")`,
  toPartyKind: sql<
    "member" | "guest" | "household"
  >`(SELECT kind FROM "LedgerParty" WHERE id = "LedgerTransfer"."toPartyId")`,
  amount: ledgerTransfer.amount,
  date: ledgerTransfer.date,
  notes: ledgerTransfer.notes,
  createdAt: ledgerTransfer.createdAt,
  updatedAt: ledgerTransfer.updatedAt,
  sourceClaims: sql<LedgerSourceClaimRow[]>`COALESCE((
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
  ), '[]'::jsonb)`,
  evidenceTransactionIds: sql<string[]>`COALESCE((
    SELECT jsonb_agg(ft.shortcode ORDER BY ft.amount DESC, ft.shortcode)
    FROM "FinancialTransaction" ft
    WHERE ft."ledgerTransferId" = "LedgerTransfer".id AND ft."deletedAt" IS NULL
  ), '[]'::jsonb)`,
} as const;

type LedgerSourceClaimRow = Omit<
  LedgerSourceClaimOut,
  "createdAt" | "updatedAt"
> & {
  createdAt: string;
  updatedAt: string;
};

const selectTransfers = (db: Database | DrizzleTransaction) =>
  unwrapDb(db).select(columns).from(ledgerTransfer);
type LedgerTransferRow = Awaited<ReturnType<typeof selectTransfers>>[number];

const classificationFor = (row: LedgerTransferRow) =>
  row.fromPartyShortcode === row.toPartyShortcode
    ? "internal_move"
    : row.toPartyKind === "household"
      ? "contribution"
      : row.fromPartyKind === "household"
        ? "household_distribution"
        : "reimbursement";

const toOut = (
  row: LedgerTransferRow,
  dataQuality: DataQuality,
): LedgerTransferOut =>
  ledgerTransferOut.parse({
    id: parseShortcodeFor("ledgerTransfer", row.shortcode),
    fromPartyId: parseShortcodeFor("ledgerParty", row.fromPartyShortcode),
    toPartyId: parseShortcodeFor("ledgerParty", row.toPartyShortcode),
    fromPartyName: row.fromPartyName,
    toPartyName: row.toPartyName,
    amount: row.amount,
    date: row.date,
    notes: row.notes,
    classification: classificationFor(row),
    sourceClaims: row.sourceClaims.map((claim) => {
      return {
        ...claim,
        createdAt: new Date(claim.createdAt),
        updatedAt: new Date(claim.updatedAt),
      };
    }),
    evidenceTransactionIds: row.evidenceTransactionIds.map((id) =>
      parseShortcodeFor("financialTransaction", id),
    ),
    dataQuality,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });

const hydrate = async (
  db: Database | DrizzleTransaction,
  rows: LedgerTransferRow[],
): Promise<LedgerTransferOut[]> => {
  const dataQualities = await loadDataQualities(
    db,
    "ledgerTransfer",
    rows.map((row) => row.id),
  );
  // SAFETY: `row` came from `rows`, which `dataQualities` was loaded for.
  return rows.map((row) => toOut(row, dataQualities.get(row.id)!));
};

const getById = async (
  db: Database | DrizzleTransaction,
  id: LedgerTransferId,
): Promise<LedgerTransferRow | undefined> => {
  const [row] = await selectTransfers(db)
    .where(and(eq(ledgerTransfer.id, id), notDeleted(ledgerTransfer)))
    .limit(1);
  return row;
};

const reader = createEntityReader<
  LedgerTransferRow,
  LedgerTransferOut,
  "ledgerTransfer",
  Database | DrizzleTransaction
>({
  entity: "ledgerTransfer",
  fetchById: getById,
  fromDB: async (db, row) => (await hydrate(db, [row]))[0]!,
});

export const getLedgerTransferByShortcode = reader.getByShortcode;

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
      status: financialTransaction.status,
      ledgerPartyId: financialAccount.ledgerPartyId,
      allocationCount: sql<number>`(
        SELECT count(*)::int FROM "FinancialTransactionAllocation" allocation
        WHERE allocation."transactionId" = "FinancialTransaction".id
          AND allocation."deletedAt" IS NULL
      )`,
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
        row.status !== "posted" ||
        cents(Math.abs(row.amount)) !== cents(transfer.amount) ||
        row.allocationCount > 0,
    )
  )
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "Transfer evidence must be posted, unallocated, and match the transfer amount.",
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

export async function createLedgerTransfer(
  db: Database,
  data: LedgerTransferCreateInput,
  actor: ActorContext,
) {
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
      entityType: "ledgerTransfer",
      entityId: created.id,
      action: "create",
    });
    return created.id;
  });
  return { output: await reader.getByID(db, id), entityId: id };
}

export async function updateLedgerTransfer(
  db: Database,
  shortcode: LedgerTransferShortcode,
  data: LedgerTransferUpdateData,
  actor: ActorContext,
) {
  const id = await resolveOrThrow(db, "ledgerTransfer", shortcode);
  await withTransaction(db, async (tx) => {
    const [locked] = await tx
      .select({ id: ledgerTransfer.id })
      .from(ledgerTransfer)
      .where(and(eq(ledgerTransfer.id, id), notDeleted(ledgerTransfer)))
      .for("update")
      .limit(1);
    if (!locked)
      throw createAppError(
        "LEDGER_TRANSFER_NOT_FOUND",
        `Ledger transfer not found: ${shortcode}`,
      );
    const before = await getById(tx, id);
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
        ? { fromPartyId: before.fromPartyId, toPartyId: before.toPartyId }
        : await resolvePartyIds(tx, {
            fromPartyId:
              data.fromPartyId ??
              parseShortcodeFor("ledgerParty", before.fromPartyShortcode),
            toPartyId:
              data.toPartyId ??
              parseShortcodeFor("ledgerParty", before.toPartyShortcode),
          });
    const amount = data.amount ?? before.amount;
    const {
      sourceClaims: _sourceClaims,
      evidenceTransactionIds: _evidenceTransactionIds,
      ...columnData
    } = data;
    const values = buildPartialUpdateValues({ ...columnData, ...parties });
    await tx
      .update(ledgerTransfer)
      .set(values)
      .where(and(eq(ledgerTransfer.id, id), notDeleted(ledgerTransfer)));
    const evidence =
      data.evidenceTransactionIds === undefined
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
            data.evidenceTransactionIds ?? [],
          );
    await replaceEvidence(tx, { id, ...parties, amount }, evidence);
    if (data.sourceClaims !== undefined)
      await replaceLedgerSourceClaims(
        tx,
        { ledgerTransferId: id, targetAmount: amount },
        data.sourceClaims ?? [],
      );
    const after = await getById(tx, id);
    if (!after)
      throw createAppError(
        "LEDGER_TRANSFER_NOT_FOUND",
        `Ledger transfer not found after update: ${shortcode}`,
      );
    const changes = computeChanges(before, after, [
      ...entityFieldModels.ledgerTransfer.audit,
    ]);
    if (changes)
      await logAuditEntry(tx, actor, {
        entityType: "ledgerTransfer",
        entityId: id,
        action: "update",
        changes,
      });
  });
  return { output: await reader.getByID(db, id), entityId: id };
}

const ledgerTransferScaffold = listScaffold("ledgerTransfer", ledgerTransfer);

export async function buildLedgerTransferWhere(
  db: Database,
  filters: LedgerTransferFilters,
) {
  const fromIds = filters.fromPartyId
    ? await resolveAllPresent(db, "ledgerParty", [filters.fromPartyId].flat())
    : undefined;
  const toIds = filters.toPartyId
    ? await resolveAllPresent(db, "ledgerParty", [filters.toPartyId].flat())
    : undefined;
  return ledgerTransferScaffold.where(filters, [
    fromIds?.length === 0 || toIds?.length === 0 ? sql`false` : undefined,
    fromIds ? inArray(ledgerTransfer.fromPartyId, fromIds) : undefined,
    toIds ? inArray(ledgerTransfer.toPartyId, toIds) : undefined,
  ]);
}

export const listLedgerTransfers = async (
  db: Database,
  filters: LedgerTransferFilters,
  sorts: SortParams[],
  pagination: PaginationParams,
) =>
  ledgerTransferScaffold.list(
    db,
    { filters, sorts, pagination },
    {
      where: await buildLedgerTransferWhere(db, filters),
      select: (page) =>
        selectTransfers(db)
          .where(page.where)
          .orderBy(...page.orderBy)
          .limit(page.limit)
          .offset(page.offset),
      hydrate: (rows) => hydrate(db, rows),
    },
  );

export const ledgerTransferRepository = entityRepository("ledgerTransfer", {
  sideEffects: false,
  lifecycle: { delete: LEDGER_TRANSFER_DELETE_EDGE_POLICY },
  get: getLedgerTransferByShortcode,
  list: listLedgerTransfers,
  create: createLedgerTransfer,
  update: updateLedgerTransfer,
});
