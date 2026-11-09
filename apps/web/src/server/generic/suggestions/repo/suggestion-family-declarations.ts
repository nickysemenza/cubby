import { recommendationFamily } from "~/server/domains/connection/repo/recommendation-family";
import { product_pairFamily } from "~/server/domains/product/repo/match/product-pair-family";
import { statementSuggestions as statement_transactionFamily } from "~/server/domains/transaction-import/repo/statement-suggestions";
import { transferPairSuggestions as transfer_pairFamily } from "~/server/domains/transaction-import/repo/transfer-pair-suggestions";
import { fieldFamily } from "~/server/generic/suggestions/repo/field-family";
export const suggestionFamilies = {
  field: fieldFamily,
  recommendation: recommendationFamily,
  statement_transaction: statement_transactionFamily,
  transfer_pair: transfer_pairFamily,
  product_pair: product_pairFamily,
};
