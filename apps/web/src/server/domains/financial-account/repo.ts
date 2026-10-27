import type { ActorContext } from "@cubby/schemas/context";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import type { OperationDisposition } from "@cubby/schemas/entity-integrity";
import type { FieldResolutions } from "@cubby/schemas/field-resolution";
import {
  type FinancialAccountCreateInput,
  type FinancialAccountUpdateData,
  financialAccountIdentity,
  financialAccountIdentityKind,
} from "@cubby/schemas/financial-account";
import {
  financialAccountCardNumbers,
  financialAccountSourceAliases,
} from "@cubby/schemas/financial-account-fields";
import { rawFinancialAccountOut } from "@cubby/schemas/financial-account-raw-read";
import {
  type FinancialAccountId,
  type FinancialAccountShortcode,
  parseShortcodeFor,
} from "@cubby/schemas/identifiers";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database, DrizzleTransaction } from "~/server/db";
import {
  effectiveFieldSql,
  inheritedFieldSql,
} from "~/server/db/computed/effective-field";
import type { IncomingEdgePolicy } from "~/server/db/entity-incoming-edges";
import {
  buildPartialUpdateValues,
  notDeleted,
  unwrapDb,
  withTransaction,
} from "~/server/db/helpers";
import {
  financialAccount,
  financialTransaction,
  ledgerParty,
  vendor,
} from "~/server/db/schema";
import { financialAccountSearch } from "~/server/domains/financial-account/search-read-financial-account";
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
} from "~/server/entity-kernel/repo/repository";
import { createEntityCrud } from "~/server/entity-kernel/repo/repository";
import { createAppError } from "~/server/errors/app-error";
import { logAuditEntry } from "~/server/generic/audit-log/repo/audit-log";
import { loadFinancialAccountTransactionEvidence } from "~/server/generic/field-explanation/repo/field-explanation-evidence";
import { listScaffold } from "~/server/generic/list/repo/list";
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

const cardholderCode = (expression: ReturnType<typeof effectiveFieldSql>) =>
  sql<
    string | null
  >`(SELECT shortcode FROM "LedgerParty" WHERE id = ${expression} AND "deletedAt" IS NULL)`;
const cardholderResolution = (row: {
  primaryCardholderMode: string;
  storedCardholder: string | null;
  fallbackCardholder: string | null;
  primaryCardholderShortcode: string | null;
  ledgerPartyShortcode: string | null;
  ledgerPartyLabel: string | null;
}): FieldResolutions => {
  const explicit =
    row.primaryCardholderMode === "explicit" || row.storedCardholder !== null;
  return {
    primaryCardholderId: {
      mode: explicit
        ? row.storedCardholder === null
          ? "none"
          : "explicit"
        : "inherit",
      storedValue: row.storedCardholder,
      value: row.primaryCardholderShortcode,
      fallbackValue: row.fallbackCardholder,
      source: explicit
        ? "Account override"
        : row.fallbackCardholder
          ? "Account member"
          : "No member cardholder",
      sourceEntity:
        !explicit && row.fallbackCardholder && row.ledgerPartyShortcode
          ? {
              entityKind: "ledgerParty",
              entityId: row.ledgerPartyShortcode,
              name: row.ledgerPartyLabel,
            }
          : null,
      matchesFallback:
        explicit &&
        row.storedCardholder !== null &&
        row.storedCardholder === row.fallbackCardholder,
      canReset: explicit,
    },
  };
};

const helperText = z.string().nullable();

export const financialAccountScaffold = listScaffold(
  "financialAccount",
  financialAccount,
  {
    derived: {
      identityKind: sql`"FinancialAccount"."identity"->>${"kind"}`,
      hasSourceAlias: sql`jsonb_array_length("FinancialAccount"."sourceAliases") > 0`,
    },
    read: {
      optionCount: "transactionCount",
      search: financialAccountSearch,
      evidence: { transactionCount: loadFinancialAccountTransactionEvidence },
      // Keys outside the read schema are helper columns the bindings read.
      columns: {
        authorizedUserItems: accountPartyPeriodItemsSql(
          sql`"FinancialAccount"."authorizedUsers"`,
        ),
        fundingPeriodItems: accountPartyPeriodItemsSql(
          sql`"FinancialAccount"."fundingPeriods"`,
        ),
        network: sql<
          string | null
        >`CASE WHEN "FinancialAccount"."identity"->>${"kind"} = ${financialAccountIdentityKind.enum.credit_card} THEN "FinancialAccount"."identity"->>'network' END`,
        providerVendorName: sql<
          string | null
        >`(SELECT name FROM "Vendor" WHERE id = "FinancialAccount"."providerVendorId")`,
        storedCardholder: cardholderCode(
          sql`${financialAccount.primaryCardholderId}`,
        ),
        fallbackCardholder: cardholderCode(
          inheritedFieldSql("financialAccount", "primaryCardholderId"),
        ),
        primaryCardholderShortcode: cardholderCode(
          effectiveFieldSql("financialAccount", "primaryCardholderId"),
        ),
        ledgerPartyShortcode: sql<
          string | null
        >`(SELECT shortcode FROM "LedgerParty" WHERE id = "FinancialAccount"."ledgerPartyId")`,
        ledgerPartyLabel: sql<
          string | null
        >`(SELECT name FROM "LedgerParty" WHERE id = "FinancialAccount"."ledgerPartyId")`,
        providerVendorShortcode: sql<
          string | null
        >`(SELECT shortcode FROM "Vendor" WHERE id = "FinancialAccount"."providerVendorId")`,
      },
      bindings: (bind) => [
        bind(
          rawFinancialAccountOut.pick({
            sourceAliasesLabel: true,
            cardNumbersLabel: true,
          }),
          (row) => ({
            sourceAliasesLabel: sourceAliasesLabel(
              financialAccountSourceAliases.parse(row.sourceAliases),
            ),
            cardNumbersLabel: cardNumbersLabel(
              financialAccountCardNumbers.parse(row.cardNumbers),
            ),
          }),
        ),
        bind(
          rawFinancialAccountOut.pick({ fieldResolutions: true }),
          (row) => ({
            fieldResolutions: cardholderResolution({
              primaryCardholderMode: row.primaryCardholderMode,
              storedCardholder: helperText.parse(row.storedCardholder),
              fallbackCardholder: helperText.parse(row.fallbackCardholder),
              primaryCardholderShortcode: helperText.parse(
                row.primaryCardholderShortcode,
              ),
              ledgerPartyShortcode: helperText.parse(row.ledgerPartyShortcode),
              ledgerPartyLabel: helperText.parse(row.ledgerPartyLabel),
            }),
          }),
        ),
        bind(
          rawFinancialAccountOut.pick({ primaryCardholderId: true }),
          (row) => {
            const code = helperText.parse(row.primaryCardholderShortcode);
            return {
              primaryCardholderId: code
                ? parseShortcodeFor("ledgerParty", code)
                : null,
            };
          },
        ),
        bind(
          rawFinancialAccountOut.pick({
            ledgerPartyId: true,
            ledgerPartyName: true,
          }),
          (row) => {
            const code = helperText.parse(row.ledgerPartyShortcode);
            return {
              ledgerPartyId: code
                ? parseShortcodeFor("ledgerParty", code)
                : null,
              ledgerPartyName: helperText.parse(row.ledgerPartyLabel),
            };
          },
        ),
        bind(rawFinancialAccountOut.pick({ providerVendorId: true }), (row) => {
          const code = helperText.parse(row.providerVendorShortcode);
          return {
            providerVendorId: code ? parseShortcodeFor("vendor", code) : null,
          };
        }),
      ],
    },
  },
);

const financialAccountCrud = createEntityCrud({
  table: financialAccount,
  entity: "financialAccount",
  scaffold: financialAccountScaffold,
  output: rawFinancialAccountOut,
  toUpdate: (data: Partial<typeof financialAccount.$inferInsert>) =>
    buildPartialUpdateValues(data),
  auditUpdateFields: [...entityFieldModels.financialAccount.audit],
});

const getFinancialAccountByID = financialAccountCrud.getByID;

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

async function draftCardholder(
  db: Database | DrizzleTransaction,
  identity: FinancialAccountCreateInput["identity"],
  owner: string | null,
  primary: string | null,
  mode: string,
) {
  if (primary !== null && identity.kind !== "credit_card")
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "Card users require a credit-card account.",
    );
  const expression = cardholderCode(
    effectiveFieldSql("financialAccount", "primaryCardholderId", "candidate"),
  );
  const result = await unwrapDb(db).execute<{ code: string | null }>(
    sql`WITH candidate AS (SELECT ${JSON.stringify(identity)}::jsonb AS identity, ${owner}::uuid AS "ledgerPartyId", ${primary}::uuid AS "primaryCardholderId", ${mode}::text AS "primaryCardholderMode") SELECT ${expression} AS code FROM candidate`,
  );
  const code = result.rows[0]?.code;
  return code ? parseShortcodeFor("ledgerParty", code) : null;
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
    .select({ id: vendor.id, systemKey: vendor.systemKey })
    .from(vendor)
    .where(and(eq(vendor.id, id), notDeleted(vendor)))
    .for("share")
    .limit(1);
  if (!row)
    throw createAppError("VENDOR_NOT_FOUND", `Vendor not found: ${shortcode}`);
  if (row.systemKey !== null)
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "Generic / Unbranded cannot provide a financial account.",
    );
  return row.id;
}

function assertProviderMatchesKind(
  identity: FinancialAccountCreateInput["identity"],
  providerVendorId: string | null,
) {
  if (identity.kind === "cash" && providerVendorId !== null)
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "Cash accounts do not have a provider.",
    );
}

/** Scalar edits merge into the backing object; they never replace its sibling values. */
function withCardIdentityFields(
  identity: FinancialAccountCreateInput["identity"],
  fields: Pick<FinancialAccountUpdateData, "network">,
): FinancialAccountCreateInput["identity"] {
  if (identity.kind !== "credit_card") {
    if (fields.network != null)
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        "Network only applies to credit-card accounts.",
      );
    return identity;
  }
  return {
    ...identity,
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
      const {
        ledgerPartyId,
        providerVendorId,
        primaryCardholderId,
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
      await validateAccountHistory(tx, {
        ...data,
        identity,
        primaryCardholderId: await draftCardholder(
          tx,
          identity,
          resolvedLedgerPartyId,
          resolvedCardholderId ?? null,
          data.primaryCardholderMode,
        ),
      });
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
      await validateAccountHistory(tx, {
        identity,
        primaryCardholderId: await draftCardholder(
          tx,
          identity,
          ledgerPartyId === undefined ? before.ledgerPartyId : ledgerPartyId,
          primaryCardholderId === undefined
            ? before.primaryCardholderId
            : primaryCardholderId,
          data.primaryCardholderMode ??
            (data.primaryCardholderId === undefined
              ? before.primaryCardholderMode
              : "explicit"),
        ),
        authorizedUsers: data.authorizedUsers ?? before.authorizedUsers,
        fundingPeriods: data.fundingPeriods ?? before.fundingPeriods,
      });
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
        network: _network,
        ...accountData
      } = data;
      const updateData: Partial<typeof financialAccount.$inferInsert> = {
        ...accountData,
        ...(data.identity !== undefined || data.network !== undefined
          ? { identity }
          : {}),
      };
      if (primaryCardholderId !== undefined)
        updateData.primaryCardholderId = primaryCardholderId;
      if (
        data.primaryCardholderId !== undefined &&
        data.primaryCardholderMode === undefined
      )
        updateData.primaryCardholderMode = "explicit";
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
  scaffold: financialAccountScaffold,
  create: asActor(createFinancialAccount),
  update: asActor(updateFinancialAccount),
});
