import { cookbookContract } from "~/contracts/cookbook.contract";
import { executeEntityAs } from "~/server/entity-kernel";
import { implementOperationDomain } from "~/server/operation-domain.server";
import { getCookbookSummary, listCookbooks } from "~/server/repo/cookbook";

export const cookbookHandlers = implementOperationDomain(cookbookContract, {
  list: (context) => listCookbooks(context.db),
  update: async (context, input) => {
    await executeEntityAs(context, "update", {
      entity: "cookbook",
      id: input.id,
      data: input.data,
    });
    const refreshed = await getCookbookSummary(context.db, input.id);
    if (refreshed === null) {
      throw new Error("Updated cookbook could not be reloaded");
    }
    return refreshed;
  },
});
