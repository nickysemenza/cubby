import { cookbookContract } from "~/contracts/cookbook.contract";
import { listCookbooks } from "~/server/domains/cookbook/repo/cookbook";
import { executeEntityAs } from "~/server/entity-kernel";
import { readPublicEntityRows } from "~/server/generic/derived/service/public-read";
import { implementOperationDomain } from "~/server/operation-runtime/operation-domain.server";

export const cookbookHandlers = implementOperationDomain(cookbookContract, {
  list: async (context) =>
    readPublicEntityRows({
      db: context.db,
      entity: "cookbook",
      projection: "output",
      rows: await listCookbooks(context.db),
    }),
  update: async (context, input) => {
    const result = await executeEntityAs(context, "update", {
      entity: "cookbook",
      id: input.id,
      data: input.data,
    });
    return { id: result.item.id };
  },
});
