import { recommendationFamily } from "~/server/domains/connection/repo/recommendation-family";
import { transferPairSuggestions as transfer_pairFamily } from "~/server/domains/financial-transaction/repo/transfer-pair-suggestions";
import { product_pairFamily } from "~/server/domains/product/repo/match/product-pair-family";
import { statementSuggestions as statement_transactionFamily } from "~/server/domains/transaction-import/repo/statement-suggestions";
import { fieldFamily } from "~/server/generic/suggestions/repo/field-family";
// Family implementations refer back to generic review; read live bindings after module initialization.
export const suggestionFamilies = {
  get field() {
    return fieldFamily;
  },
  get recommendation() {
    return recommendationFamily;
  },
  get statement_transaction() {
    return statement_transactionFamily;
  },
  get transfer_pair() {
    return transfer_pairFamily;
  },
  get product_pair() {
    return product_pairFamily;
  },
};
