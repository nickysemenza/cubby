import { productMatchContract } from "~/contracts/product-match.contract";
import { proposeProductMatch } from "~/server/domains/product/repo/match/product-match-review";
import { implementOperationDomain } from "~/server/operation-runtime/operation-domain.server";
export const productMatchHandlers = implementOperationDomain(
  productMatchContract,
  {
    proposeProductMatch: (context, input) =>
      proposeProductMatch(context.db, input),
  },
);
