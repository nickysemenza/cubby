import { cookbookContract } from "~/contracts/cookbook.contract";
import { implementOperationDomain } from "~/server/operation-domain.server";
import { getCookbookSummary, listCookbooks } from "~/server/repo/cookbook";

export const cookbookHandlers = implementOperationDomain(cookbookContract, {
  list: (context) => listCookbooks(context.readDb),
  detail: {
    run: (context, input) => getCookbookSummary(context.db, input.shortcode),
  },
});
