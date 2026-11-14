import { financialTransactionCreateInput } from "@cubby/schemas/financial-transaction";
import { minorToMoney } from "@cubby/shared";
import { eq, or, sql, type SQL } from "drizzle-orm";
import { TEST_ACTOR } from "tooling/test-setup";

import type { Database } from "~/server/db/database";
import { repositoryQueries } from "~/server/db/repository-access.boundary";
import { financialAccount, financialTransaction } from "~/server/db/schema";

import {
  createBankTransactions,
  updateBankTransactions,
} from "./bank-mutations";

/** Synthetic predecessors and journeys seed through the money writer. */
export async function seedBankTransaction(
  db: Database,
  values: Omit<typeof financialTransaction.$inferInsert, "shortcode">,
) {
  const [account] = await repositoryQueries(db)
    .select({ shortcode: financialAccount.shortcode })
    .from(financialAccount)
    .where(eq(financialAccount.id, values.accountId));
  if (!account) throw new Error("Synthetic account is missing");
  const { accountId: _accountCode, ...input } =
    financialTransactionCreateInput.parse({
      accountId: account.shortcode,
      kind: values.kind,
      status: values.status,
      transactionDate: values.transactionDate,
      postedDate: values.postedDate,
      merchant: values.merchant,
      rawDescription: values.rawDescription,
      sourceCategory: values.sourceCategory,
      notes: values.notes,
      itemizationExpectation: values.itemizationExpectation,
      amount: minorToMoney(values.amount),
      sourceRefs: [],
      allocations: [],
    });
  const [row] = await createBankTransactions(
    db,
    [{ data: input, accountId: values.accountId }],
    TEST_ACTOR,
  );
  if (!row)
    throw new Error("Synthetic bank event did not produce a transaction");
  if (values.spendingCategoryId !== undefined)
    await updateBankTransactions(
      db,
      [
        {
          id: row.id,
          values: { spendingCategoryId: values.spendingCategoryId },
        },
      ],
      TEST_ACTOR,
    );
  const {
    id: _id,
    accountId: _account,
    amount: _amount,
    kind: _kind,
    status: _status,
    transactionDate: _transaction,
    postedDate: _posted,
    merchant: _merchant,
    rawDescription: _description,
    sourceCategory: _sourceCategory,
    notes: _notes,
    spendingCategoryId: _category,
    itemizationExpectation: _itemization,
    ...metadata
  } = values;
  if (Object.keys(metadata).length)
    await repositoryQueries(db)
      .update(financialTransaction)
      .set(metadata)
      .where(eq(financialTransaction.id, row.id));
  const [saved] = await repositoryQueries(db)
    .select()
    .from(financialTransaction)
    .where(eq(financialTransaction.id, row.id));
  return saved!;
}

export async function updateSeedBankTransaction(
  db: Database,
  key: string,
  values: Partial<typeof financialTransaction.$inferInsert>,
): Promise<void> {
  const [row] = await repositoryQueries(db)
    .select({ id: financialTransaction.id })
    .from(financialTransaction)
    .where(
      or(
        eq(financialTransaction.shortcode, key),
        eq(sql`${financialTransaction.id}::text`, key),
      ),
    );
  if (!row) throw new Error("Synthetic transaction is missing");
  await updateBankTransactions(db, [{ id: row.id, values }], TEST_ACTOR);
}

/** Fixture corrections retain the production bank-event decision boundary. */
export async function updateBankTransactionsWhere(
  db: Database,
  values: Partial<typeof financialTransaction.$inferInsert>,
  where: SQL | undefined,
) {
  const rows = await repositoryQueries(db)
    .select()
    .from(financialTransaction)
    .where(where);
  await updateBankTransactions(
    db,
    rows.map((row) => ({ id: row.id, values })),
    TEST_ACTOR,
  );
  const { bankTransactionWrites } = await import("./bank-event");
  const metadata = Object.fromEntries(
    Object.entries(values).filter(
      ([field]) => !bankTransactionWrites.columns.includes(field),
    ),
  );
  if (Object.keys(metadata).length)
    await repositoryQueries(db)
      .update(financialTransaction)
      .set(metadata)
      .where(where);
}
