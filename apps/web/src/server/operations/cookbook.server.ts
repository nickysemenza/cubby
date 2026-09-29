import { cookbookContract } from "~/contracts/cookbook.contract";
import { executeEntity } from "~/server/entity-kernel";
import { implementOperationDomain } from "~/server/operation-domain.server";
import { getCookbookSummary, listCookbooks } from "~/server/repo/cookbook";

export const cookbookHandlers = implementOperationDomain(cookbookContract, {
  list: (context) => listCookbooks(context.db),
  detail: (context, input) => getCookbookSummary(context.db, input.shortcode),
  update: async (context, input) => {
    const result = await executeEntity(context, {
      action: "update",
      entity: "cookbook",
      id: input.id,
      data: input.data,
    });
    if (result.action !== "update") {
      throw new Error("Cookbook update returned the wrong entity action");
    }
    const refreshed = await getCookbookSummary(context.db, input.id);
    if (refreshed === null) {
      throw new Error("Updated cookbook could not be reloaded");
    }
    return refreshed;
  },
});
