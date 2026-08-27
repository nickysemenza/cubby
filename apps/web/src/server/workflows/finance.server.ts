import type { Database } from "~/server/db";
import { financialAccountOptions } from "~/server/repo/financial-account";
import { financialTransactionSourceOptions } from "~/server/repo/financial-transaction";
export const financialAccountOptionsWorkflow = (db: Database) =>
  financialAccountOptions(db);
export const financialTransactionSourceOptionsWorkflow = (db: Database) =>
  financialTransactionSourceOptions(db);
