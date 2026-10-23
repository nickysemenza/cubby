import type { ActorContext } from "@cubby/schemas/context";
import type { DataQuality } from "@cubby/schemas/data-quality";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import type { OperationDisposition } from "@cubby/schemas/entity-integrity";
import {
  type FinancialAccountCreateInput,
  type FinancialAccountFilters,
  type FinancialAccountOut,
  type FinancialAccountUpdateData,
  financialAccountCardNumbers,
  financialAccountIdentity,
  financialAccountIdentityKind,
  financialAccountOut,
  financialAccountSourceAliases,
} from "@cubby/schemas/financial-account";
import {
  type FinancialAccountId,
  type FinancialAccountShortcode,
  parseShortcodeFor,
} from "@cubby/schemas/identifiers";
import {
  type PaginationParams,
  type SortParams,
} from "@cubby/schemas/pagination";
import { and, eq, sql } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import type { IncomingEdgePolicy } from "~/server/db/entity-incoming-edges";
import {
  buildPartialUpdateValues,
  notDeleted,
  unwrapDb,
  withTransaction,
} from "~/server/db/helpers";
import type { ListReadIntent } from "~/server/db/helpers/query";
import {
  financialAccount,
  financialTransaction,
  ledgerParty,
  vendor,
} from "~/server/db/schema";
import { lockFinancialEvidenceKeys } from "~/server/domains/financial-transaction/repo/financial-evidence";
import {
  resolveMemberAssignee,
  lockLedgerPartiesForReference,
} from "~/server/domains/ledger-party/repo/ledger-party-reference";
import {
  cardNumbersLabel,
  sourceAliasesLabel,
} from "~/server/entity-kernel/repo/detail-display-labels";
import {
  type MutationReceipt,
  defineMutationWriter,
} from "~/server/entity-kernel/repo/repository";
import {
  asActor,
  defineRepository,
  listOn,
  listReadOn,
  onDb,
} from "~/server/entity-kernel/repo/repository";
import { createEntityCrud } from "~/server/entity-kernel/repo/repository";
import { createAppError } from "~/server/errors/app-error";
import { logAuditEntry } from "~/server/generic/audit-log/repo/audit-log";
import { loadDataQualities } from "~/server/generic/data-quality/repo/hydrate";
import { listScaffold } from "~/server/generic/list/repo/list";
import type { ListProjection } from "~/server/generic/list/repo/list-contracts";
import {
  listGroupFields,
  type ListReadOptions,
} from "~/server/generic/list/repo/list-projection";
import { completeListReader } from "~/server/generic/list/repo/list-read-adapters";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

import { accountPartyPeriodItemsSql } from "./repo/funding-sql";

export const FINANCIAL_ACCOUNT_DELETE_EDGE_POLICY = {
  "EmailFinancialAssociation.reviewedAccountId": {
    code: "preserve-reviewed-email-association",
    effect: "preserve",
    description:
      "A reviewed Email association keeps naming the deleted account's tombstone; the review is history and is never rewritten.",
  },
  "FinancialTransaction.accountId": {
    code: "block-live-financial-transactions",
    effect: "block",
    description:
      "An account cannot be deleted while live financial transactions still retain settlement evidence against it.",
  },
  "EntityLink[purchasePaymentAccount].to": {
    code: "soft-delete-association",
    effect: "soft-delete",
    description:
      "A member's assertion that this account paid an order is soft-deleted with the account; the order's paying accounts fall back to its payment evidence.",
  },
  "SourceTransactionRecord.accountId": {
    code: "block-live-source-transaction-records",
    effect: "block",
    description:
      "An account cannot be deleted while live statement rows are assigned to it. The column is nullable, so detaching would succeed silently — and it would discard the triage judgment that put the row on this account while leaving the row looking untriaged.",
  },
} as const satisfies IncomingEdgePolicy<
  "financialAccount",
  OperationDisposition
>;

export const financialAccountTransactionCount = sql<number>`(
  SELECT count(*)::int FROM "FinancialTransaction" ft
  WHERE ft."accountId" = "FinancialAccount"."id" AND ft."deletedAt" IS NULL
)`;

const columns = {
  authorizedUserItems: accountPartyPeriodItemsSql(
    sql`"FinancialAccount"."authorizedUsers"`,
  ),
  fundingPeriodItems: accountPartyPeriodItemsSql(
    sql`"FinancialAccount"."fundingPeriods"`,
  ),
  authorizedUsers: financialAccount.authorizedUsers,
  fundingPeriods: financialAccount.fundingPeriods,
  primaryCardholderShortcode: sql<
    string | null
  >`(SELECT shortcode FROM "LedgerParty" WHERE id = "FinancialAccount"."primaryCardholderId")`,
  id: financialAccount.id,
  shortcode: financialAccount.shortcode,
  name: financialAccount.name,
  issuer: sql<
    string | null
  >`CASE WHEN "FinancialAccount"."identity"->>${"kind"} = ${financialAccountIdentityKind.enum.credit_card} THEN "FinancialAccount"."identity"->>'issuer' END`,
  network: sql<
    string | null
  >`CASE WHEN "FinancialAccount"."identity"->>${"kind"} = ${financialAccountIdentityKind.enum.credit_card} THEN "FinancialAccount"."identity"->>'network' END`,
  identity: financialAccount.identity,
  provisional: financialAccount.provisional,
  sourceAliases: financialAccount.sourceAliases,
  cardNumbers: financialAccount.cardNumbers,
  inventoryOwnerDefaultEnabled: financialAccount.inventoryOwnerDefaultEnabled,
  ledgerPartyShortcode: sql<
    string | null
  >`(SELECT shortcode FROM "LedgerParty" WHERE id = "FinancialAccount"."ledgerPartyId")`,
  ledgerPartyName: sql<
    string | null
  >`(SELECT name FROM "LedgerParty" WHERE id = "FinancialAccount"."ledgerPartyId")`,
  providerVendorShortcode: sql<
    string | null
  >`(SELECT shortcode FROM "Vendor" WHERE id = "FinancialAccount"."providerVendorId")`,
  providerVendorName: sql<
    string | null
  >`(SELECT name FROM "Vendor" WHERE id = "FinancialAccount"."providerVendorId")`,
  notes: financialAccount.notes,
  createdAt: financialAccount.createdAt,
  updatedAt: financialAccount.updatedAt,
  transactionCount: financialAccountTransactionCount,
} as const;

const selectAccounts = (db: Database | DrizzleTransaction) =>
  unwrapDb(db).select(columns).from(financialAccount);
type FinancialAccountRow = Awaited<ReturnType<typeof selectAccounts>>[number];

const hydrate = async (
  db: Database | DrizzleTransaction,
  rows: FinancialAccountRow[],
): Promise<FinancialAccountOut[]> => {
  const dataQualities = await loadDataQualities(
    db,
    "financialAccount",
    rows.map((row) => row.id),
  );
  // SAFETY: `row` came from `rows`, which `dataQualities` was loaded for.
  return rows.map((row) => toOut(row, dataQualities.get(row.id)!));
};

const toOut = (
  row: FinancialAccountRow,
  dataQuality: DataQuality,
): FinancialAccountOut => {
  const sourceAliases = financialAccountSourceAliases.parse(row.sourceAliases);
  const cardNumbers = financialAccountCardNumbers.parse(row.cardNumbers);
  return financialAccountOut.parse({
    id: parseShortcodeFor("financialAccount", row.shortcode),
    name: row.name,
    authorizedUserItems: row.authorizedUserItems,
    fundingPeriodItems: row.fundingPeriodItems,
    authorizedUsers: row.authorizedUsers,
    fundingPeriods: row.fundingPeriods,
    primaryCardholderId: row.primaryCardholderShortcode,
    issuer: row.issuer,
    network: row.network,
    identity: financialAccountIdentity.parse(row.identity),
    provisional: row.provisional,
    sourceAliases,
    sourceAliasesLabel: sourceAliasesLabel(sourceAliases),
    cardNumbers,
    cardNumbersLabel: cardNumbersLabel(cardNumbers),
    inventoryOwnerDefaultEnabled: row.inventoryOwnerDefaultEnabled,
    ledgerPartyId: row.ledgerPartyShortcode
      ? parseShortcodeFor("ledgerParty", row.ledgerPartyShortcode)
      : null,
    ledgerPartyName: row.ledgerPartyName,
    providerVendorId: row.providerVendorShortcode
      ? parseShortcodeFor("vendor", row.providerVendorShortcode)
      : null,
    providerVendorName: row.providerVendorName,
    notes: row.notes,
    transactionCount: Number(row.transactionCount),
    dataQuality,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
};

const selectAccountsRead = (
  db: Database | DrizzleTransaction,
  projection: ListProjection,
) => {
  const {
    ledgerPartyShortcode,
    ledgerPartyName,
    providerVendorShortcode,
    providerVendorName,
    transactionCount,
    ...core
  } = columns;
  return unwrapDb(db)
    .select({
      ...core,
      ...listGroupFields(projection, "relations", () => ({
        ledgerPartyShortcode,
        ledgerPartyName,
        providerVendorShortcode,
        providerVendorName,
      })),
      ...listGroupFields(projection, "derived", () => ({ transactionCount })),
    })
    .from(financialAccount);
};
const accountRead = {
  bindings: (bind) => [
    bind(financialAccountOut.pick({ primaryCardholderId: true }), (row) => ({
      primaryCardholderId: row.primaryCardholderShortcode
        ? parseShortcodeFor("ledgerParty", row.primaryCardholderShortcode)
        : null,
    })),
    bind(financialAccountOut.pick({ ledgerPartyId: true }), (row) => ({
      ledgerPartyId: row.ledgerPartyShortcode
        ? parseShortcodeFor("ledgerParty", row.ledgerPartyShortcode)
        : null,
    })),
    bind(financialAccountOut.pick({ providerVendorId: true }), (row) => ({
      providerVendorId: row.providerVendorShortcode
        ? parseShortcodeFor("vendor", row.providerVendorShortcode)
        : null,
    })),
  ],
} satisfies ListReadOptions<
  Awaited<ReturnType<typeof selectAccountsRead>>[number]
>;

const financialAccountScaffold = listScaffold(
  "financialAccount",
  financialAccount,
  {
    derived: {
      transactionCount: financialAccountTransactionCount,
      identityKind: sql`"FinancialAccount"."identity"->>${"kind"}`,
      hasSourceAlias: sql`jsonb_array_length("FinancialAccount"."sourceAliases") > 0`,
    },
  },
);

/** The complete WHERE for this entity's list. `getEntityCounts` calls it with `{}` — see repo/dashboard.ts. */
export const buildFinancialAccountWhere = async (
  db: Database | DrizzleTransaction,
  filters: FinancialAccountFilters,
) =>
  financialAccountScaffold.where(filters, {
    context: await financialAccountScaffold.context(db, {
      filters,
      readIntent: "count",
    }),
  });

export const listFinancialAccountsRead = (
  db: Database,
  filters: FinancialAccountFilters,
  sorts: SortParams[],
  pagination: PaginationParams,
  projection: ListProjection = { kind: "full" },
  readIntent: ListReadIntent = "page",
) =>
  financialAccountScaffold.read(
    db,
    { filters, sorts, pagination, projection, readIntent },
    {
      select: (page) =>
        selectAccountsRead(db, projection)
          .where(page.where)
          .orderBy(...page.orderBy)
          .limit(page.limit)
          .offset(page.offset),
      read: accountRead,
    },
  );

export const listFinancialAccounts = completeListReader(
  financialAccountOut,
  listFinancialAccountsRead,
);

/**
 * The audited-update unit: `update` runs the before-state read, column UPDATE,
 * diff audit and re-read in one transaction. Its row carries the raw
 * `ledgerPartyId` / `providerVendorId` beside the list columns so the audit
 * diffs the reference columns, not only their display shortcodes.
 */
const financialAccountCrud = createEntityCrud({
  table: financialAccount,
  entity: "financialAccount",
  fetchById: async (db, id) => {
    const [row] = await unwrapDb(db)
      .select({
        ...columns,
        ledgerPartyId: financialAccount.ledgerPartyId,
        primaryCardholderId: financialAccount.primaryCardholderId,
        providerVendorId: financialAccount.providerVendorId,
      })
      .from(financialAccount)
      .where(and(eq(financialAccount.id, id), notDeleted(financialAccount)))
      .limit(1);
    return row;
  },
  fromDB: async (db, row) => (await hydrate(db, [row]))[0]!,
  toUpdate: (data: Partial<typeof financialAccount.$inferInsert>) =>
    buildPartialUpdateValues(data),
  auditUpdateFields: [...entityFieldModels.financialAccount.audit],
});

const getFinancialAccountByID = financialAccountCrud.getByID;
const getFinancialAccountByShortcode = financialAccountCrud.getByShortcode;

async function assertAliasesAvailable(
  db: Database | DrizzleTransaction,
  aliases: FinancialAccountCreateInput["sourceAliases"],
  exceptId?: FinancialAccountId,
) {
  for (const alias of aliases) {
    if (!alias.externalAccountId) continue;
    const rows = await unwrapDb(db).execute<{ id: string }>(sql`
      SELECT fa.id::text AS id
      FROM "FinancialAccount" fa
      CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(fa."sourceAliases") = 'array' THEN fa."sourceAliases" ELSE '[]'::jsonb END) a
      WHERE fa."deletedAt" IS NULL
        AND a->>${"source"} = ${alias.source}
        AND a->>'externalAccountId' = ${alias.externalAccountId}
        ${exceptId ? sql`AND fa.id <> ${exceptId}` : sql``}
      LIMIT 1
    `);
    if (rows.rows[0]) {
      throw createAppError(
        "FINANCIAL_ACCOUNT_SOURCE_ALIAS_CONFLICT",
        `Source account ${alias.source}/${alias.externalAccountId} is already linked to another financial account.`,
      );
    }
  }
}

async function validateAccountHistory(
  tx: DrizzleTransaction,
  data: Pick<
    FinancialAccountCreateInput,
    "identity" | "primaryCardholderId" | "authorizedUsers" | "fundingPeriods"
  >,
) {
  if (
    (data.primaryCardholderId !== null || data.authorizedUsers.length > 0) &&
    data.identity.kind !== "credit_card"
  )
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "Card users require a credit-card account.",
    );
  if (data.authorizedUsers.length > 0 && data.primaryCardholderId === null)
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "Authorized users require a primary cardholder.",
    );
  if (
    data.authorizedUsers.some(
      (row) => row.ledgerPartyId === data.primaryCardholderId,
    )
  )
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "The primary cardholder cannot also be an authorized user.",
    );
  const members = await lockLedgerPartiesForReference(
    tx,
    data.authorizedUsers.map((row) => row.ledgerPartyId),
  );
  if (members.some((row) => row.kind !== "member"))
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "Authorized users must be household members.",
    );
  const funders = await lockLedgerPartiesForReference(
    tx,
    data.fundingPeriods.map((row) => row.ledgerPartyId),
  );
  if (funders.some((row) => row.kind === "guest"))
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "Funding periods require members or the household.",
    );
}

async function resolveLedgerPartyForAccount(
  tx: DrizzleTransaction,
  shortcode: FinancialAccountCreateInput["ledgerPartyId"],
) {
  if (shortcode === null) return null;
  const [party] = await lockLedgerPartiesForReference(tx, [shortcode]);
  if (!party || party.kind === "guest")
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "A financial account may map only to a member or the household ledger party.",
    );
  return party.id;
}

async function resolveProviderVendorForAccount(
  tx: DrizzleTransaction,
  shortcode: FinancialAccountCreateInput["providerVendorId"],
) {
  if (shortcode === null) return null;
  const id = await resolveOrThrow(tx, "vendor", shortcode);
  // Row lock so a concurrent vendor delete cannot pass its incoming-edge
  // check between this read and the insert that references it.
  const [row] = await tx
    .select({ id: vendor.id })
    .from(vendor)
    .where(and(eq(vendor.id, id), notDeleted(vendor)))
    .for("share")
    .limit(1);
  if (!row)
    throw createAppError("VENDOR_NOT_FOUND", `Vendor not found: ${shortcode}`);
  return row.id;
}

function assertProviderMatchesKind(
  identity: FinancialAccountCreateInput["identity"],
  providerVendorId: string | null,
) {
  if (providerVendorId !== null && identity.kind !== "stored_value")
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      `Only a stored-value account names a provider vendor; this account is ${identity.kind}.`,
    );
}

/** Scalar edits merge into the backing object; they never replace its sibling values. */
function withCardIdentityFields(
  identity: FinancialAccountCreateInput["identity"],
  fields: Pick<FinancialAccountUpdateData, "issuer" | "network">,
): FinancialAccountCreateInput["identity"] {
  if (identity.kind !== "credit_card") {
    if (fields.issuer != null || fields.network != null)
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        "Issuer and network only apply to credit-card accounts.",
      );
    return identity;
  }
  return {
    ...identity,
    ...(fields.issuer !== undefined ? { issuer: fields.issuer } : {}),
    ...(fields.network !== undefined ? { network: fields.network } : {}),
  };
}

export const createFinancialAccount = defineMutationWriter({
  entity: "financialAccount",
  read: async (
    receipt: MutationReceipt<"financialAccount">,
    db: Database,
    _data: FinancialAccountCreateInput,
    _actor: ActorContext,
  ) => ({
    output: await getFinancialAccountByID(db, receipt.entityId),
    entityId: receipt.entityId,
  }),
  write: async (
    readOutput,
    db: Database,
    data: FinancialAccountCreateInput,
    actor: ActorContext,
  ) => {
    const identity =
      data.identity.kind === "credit_card"
        ? withCardIdentityFields(data.identity, data)
        : data.identity;
    const id = await withTransaction(db, async (tx) => {
      await lockFinancialEvidenceKeys(
        tx,
        "account-alias",
        data.sourceAliases.flatMap((alias) =>
          alias.externalAccountId
            ? [`${alias.source}\0${alias.externalAccountId}`]
            : [],
        ),
      );
      await assertAliasesAvailable(tx, data.sourceAliases);
      await validateAccountHistory(tx, { ...data, identity });
      const {
        ledgerPartyId,
        providerVendorId,
        primaryCardholderId,
        issuer: _issuer,
        network: _network,
        ...columns
      } = data;
      const resolvedCardholderId = await resolveMemberAssignee(
        tx,
        primaryCardholderId,
      );
      const resolvedLedgerPartyId = await resolveLedgerPartyForAccount(
        tx,
        ledgerPartyId,
      );
      const resolvedProviderVendorId = await resolveProviderVendorForAccount(
        tx,
        providerVendorId,
      );
      assertProviderMatchesKind(identity, resolvedProviderVendorId);
      if (data.inventoryOwnerDefaultEnabled) {
        if (!resolvedLedgerPartyId) {
          throw createAppError(
            "CONSTRAINT_VIOLATION",
            "An inventory owner default requires an individual account owner.",
          );
        }
        const party = await tx.query.ledgerParty.findFirst({
          where: eq(ledgerParty.id, resolvedLedgerPartyId),
          columns: { kind: true },
        });
        if (party?.kind !== "member") {
          throw createAppError(
            "CONSTRAINT_VIOLATION",
            "An inventory owner default requires an individual account owner.",
          );
        }
      }
      const created = await insertWithShortcode(tx, "financialAccount", {
        ...columns,
        identity,
        primaryCardholderId: resolvedCardholderId,
        ledgerPartyId: resolvedLedgerPartyId,
        providerVendorId: resolvedProviderVendorId,
      });
      await logAuditEntry(tx, actor, {
        entityKind: "financialAccount",
        entityId: created.id,
        action: "create",
      });
      return created.id;
    });
    return readOutput({ entityId: id });
  },
});

export const updateFinancialAccount = defineMutationWriter({
  entity: "financialAccount",
  read: async (
    receipt: MutationReceipt<"financialAccount">,
    db: Database,
    _id: FinancialAccountShortcode,
    _data: FinancialAccountUpdateData,
    _actor: ActorContext,
  ) => ({
    output: await getFinancialAccountByID(db, receipt.entityId),
    entityId: receipt.entityId,
  }),
  write: async (
    readOutput,
    db: Database,
    id: FinancialAccountShortcode,
    data: FinancialAccountUpdateData,
    actor: ActorContext,
  ) => {
    const accountId = await resolveOrThrow(db, "financialAccount", id);
    const output = await withTransaction(db, async (tx) => {
      const [before] = await tx
        .select()
        .from(financialAccount)
        .where(
          and(eq(financialAccount.id, accountId), notDeleted(financialAccount)),
        )
        .for("update")
        .limit(1);
      if (!before)
        throw createAppError(
          "FINANCIAL_ACCOUNT_NOT_FOUND",
          `Financial account not found: ${id}`,
        );
      const primaryCardholderId = await resolveMemberAssignee(
        tx,
        data.primaryCardholderId,
      );
      const [currentCardholder] = before.primaryCardholderId
        ? await tx
            .select({ shortcode: ledgerParty.shortcode })
            .from(ledgerParty)
            .where(eq(ledgerParty.id, before.primaryCardholderId))
        : [];
      await validateAccountHistory(tx, {
        identity: financialAccountIdentity.parse(before.identity),
        primaryCardholderId:
          data.primaryCardholderId === undefined
            ? currentCardholder
              ? parseShortcodeFor("ledgerParty", currentCardholder.shortcode)
              : null
            : data.primaryCardholderId,
        authorizedUsers: data.authorizedUsers ?? before.authorizedUsers,
        fundingPeriods: data.fundingPeriods ?? before.fundingPeriods,
      });
      if (data.sourceAliases !== undefined) {
        await lockFinancialEvidenceKeys(
          tx,
          "account-alias",
          data.sourceAliases.flatMap((alias) =>
            alias.externalAccountId
              ? [`${alias.source}\0${alias.externalAccountId}`]
              : [],
          ),
        );
        await assertAliasesAvailable(tx, data.sourceAliases, accountId);
      }
      const ledgerPartyId =
        data.ledgerPartyId === undefined
          ? undefined
          : await resolveLedgerPartyForAccount(tx, data.ledgerPartyId);
      const providerVendorId =
        data.providerVendorId === undefined
          ? undefined
          : await resolveProviderVendorForAccount(tx, data.providerVendorId);
      // The identity kind is the discriminator statement routing depends on, so it is chosen
      // at creation; the other identity fields and the card numbers stay editable.
      const beforeIdentity = financialAccountIdentity.parse(before.identity);
      if (
        data.identity !== undefined &&
        data.identity.kind !== beforeIdentity.kind
      )
        throw createAppError(
          "CONSTRAINT_VIOLATION",
          `An account's identity kind is fixed at creation (this account is ${beforeIdentity.kind}); create a new account for a ${data.identity.kind}.`,
        );
      const identity = withCardIdentityFields(
        data.identity ?? beforeIdentity,
        data,
      );
      assertProviderMatchesKind(
        identity,
        providerVendorId === undefined
          ? before.providerVendorId
          : providerVendorId,
      );
      const inventoryOwnerDefaultEnabled =
        data.inventoryOwnerDefaultEnabled ??
        before.inventoryOwnerDefaultEnabled;
      if (inventoryOwnerDefaultEnabled) {
        const effectivePartyId =
          ledgerPartyId === undefined ? before.ledgerPartyId : ledgerPartyId;
        const party = effectivePartyId
          ? await tx.query.ledgerParty.findFirst({
              where: and(
                eq(ledgerParty.id, effectivePartyId),
                notDeleted(ledgerParty),
              ),
              columns: { kind: true },
            })
          : null;
        if (party?.kind !== "member") {
          throw createAppError(
            "CONSTRAINT_VIOLATION",
            "An inventory owner default requires an individual account owner.",
          );
        }
      }
      if (
        ledgerPartyId !== undefined &&
        ledgerPartyId !== before.ledgerPartyId
      ) {
        const [linkedEvidence] = await tx
          .select({ id: financialTransaction.id })
          .from(financialTransaction)
          .where(
            and(
              eq(financialTransaction.accountId, accountId),
              sql`${financialTransaction.ledgerTransferId} IS NOT NULL`,
              notDeleted(financialTransaction),
            ),
          )
          .limit(1);
        if (linkedEvidence)
          throw createAppError(
            "CONSTRAINT_VIOLATION",
            "Cannot change an account's ledger party while it evidences a ledger transfer.",
          );
      }
      const {
        ledgerPartyId: _ledgerPartyId,
        providerVendorId: _providerVendorId,
        primaryCardholderId: _primaryCardholderId,
        issuer: _issuer,
        network: _network,
        ...accountData
      } = data;
      const updateData: Partial<typeof financialAccount.$inferInsert> = {
        ...accountData,
        ...(data.identity !== undefined ||
        data.issuer !== undefined ||
        data.network !== undefined
          ? { identity }
          : {}),
      };
      if (primaryCardholderId !== undefined)
        updateData.primaryCardholderId = primaryCardholderId;
      if (ledgerPartyId !== undefined) updateData.ledgerPartyId = ledgerPartyId;
      if (providerVendorId !== undefined)
        updateData.providerVendorId = providerVendorId;
      return financialAccountCrud.update(
        tx,
        accountId,
        updateData,
        actor,
        async (_db, receipt) =>
          readOutput(receipt, async () => ({
            output: await financialAccountCrud.getByID(tx, accountId),
            entityId: accountId,
          })),
      );
    });
    return output;
  },
});

export const financialAccountRepository = defineRepository("financialAccount", {
  lifecycle: { delete: FINANCIAL_ACCOUNT_DELETE_EDGE_POLICY },
  get: onDb(getFinancialAccountByShortcode),
  list: listOn(listFinancialAccounts),
  listRead: listReadOn(listFinancialAccountsRead),
  create: asActor(createFinancialAccount),
  update: asActor(updateFinancialAccount),
});
