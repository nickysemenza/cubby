import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";
import { sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { notDeleted } from "~/server/db/helpers/predicates";
import { financialAccount } from "~/server/db/schema";
import {
  workExpenseOwners,
  workExpenseSourceOwners,
} from "~/server/domains/expense/repo/work-owners";
import { financialTransactionWorkOwners } from "~/server/domains/financial-transaction/repo/work-facts";
import {
  workImageOwners,
  workImageIsShared,
} from "~/server/domains/image/repo/work-owners";
import {
  workPurchaseOwners,
  workPurchaseSourceOwners,
} from "~/server/domains/purchase/repo/work-owners";
import { workRunReviewOwners } from "~/server/domains/run/repo/work-owners";

const accountOwners = (_id: SQL) =>
  sql`ARRAY["FinancialAccount"."ledgerPartyId"]`;
const transactionTenderOwners = (_id: SQL) =>
  sql`ARRAY(SELECT account."ledgerPartyId" FROM "FinancialAccount" account WHERE account.id = "FinancialTransaction"."accountId" AND ${notDeleted(alias(financialAccount, "account"))})`;

const owners = {
  purchase: { source: workPurchaseSourceOwners, tender: workPurchaseOwners },
  expense: { source: workExpenseSourceOwners, tender: workExpenseOwners },
  financialTransaction: {
    source: financialTransactionWorkOwners,
    tender: transactionTenderOwners,
  },
  financialAccount: { source: accountOwners, tender: accountOwners },
  image: { source: workImageOwners },
  run: { source: workRunReviewOwners },
  vendorAccount: { source: () => sql`ARRAY["VendorAccount"."ledgerPartyId"]` },
  email: { source: () => sql`ARRAY["Email"."ledgerPartyId"]` },
} satisfies Partial<
  Record<
    ShortcodeEntity,
    { source: (id: SQL) => SQL; tender?: (id: SQL) => SQL }
  >
>;

type SourceOwnersTable = Partial<
  Record<ShortcodeEntity, { source: (id: SQL) => SQL }>
>;

const sourceOwnerFor = (table: SourceOwnersTable, entity: ShortcodeEntity) =>
  table[entity];

export const workSourceAuthority = (entity: ShortcodeEntity, id: SQL) => {
  const entry = sourceOwnerFor(owners, entity);
  return entry
    ? {
        owners: entry.source(id),
        shared: entity === "image" ? workImageIsShared(id) : false,
      }
    : { owners: sql`ARRAY[]::uuid[]`, shared: true };
};

export const workTenderOwners = (
  entity: "purchase" | "expense" | "financialAccount" | "financialTransaction",
  id: SQL,
) => owners[entity].tender(id);
