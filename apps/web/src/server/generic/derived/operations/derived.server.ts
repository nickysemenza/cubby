import { derivedContract } from "~/contracts/derived.contract";
import { readDerivedBacklog } from "~/server/generic/derived/repo/backlog";
import { implementOperationDomain } from "~/server/operation-runtime/operation-domain.server";

export const derivedHandlers = implementOperationDomain(derivedContract, {
  backlog: (context) => readDerivedBacklog(context.db),
});
