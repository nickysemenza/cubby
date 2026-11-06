import { relatednessContract } from "~/contracts/relatedness.contract";
import { getEntityRelatedness } from "~/server/generic/relatedness/service/relatedness.service";
import { implementOperationDomain } from "~/server/operation-runtime/operation-domain.server";

export const relatednessHandlers = implementOperationDomain(
  relatednessContract,
  {
    forEntity: (context, input) => getEntityRelatedness(context.db, input),
  },
);
