import { z } from "zod";
import { transactionImportBaseFilterFields } from "./generated/transactionImport.gen";
export {
  transactionImportOut,
  type TransactionImportOut,
} from "./generated/transactionImport.gen";
export const transactionImportFilterFields = {
  ...transactionImportBaseFilterFields,
};
export const transactionImportFilters = z.object(transactionImportFilterFields);
export type TransactionImportFilters = z.infer<typeof transactionImportFilters>;
