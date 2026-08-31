import { cookbook } from "~/entities/cookbook.functions";
import { implementOperationDomain } from "~/server/operation-domain.server";
import { getCookbookSummary, listCookbooks } from "~/server/repo/cookbook";

export const cookbookHandlers = implementOperationDomain(cookbook, {
  list: (context) => listCookbooks(context.readDb),
  detail: {
    run: (context, input) => getCookbookSummary(context.db, input.shortcode),
  },
});
