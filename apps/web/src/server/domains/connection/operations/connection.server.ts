import { connectionContract } from "~/contracts/entity-graph.contract";
import { readEntityConnections } from "~/server/domains/connection/repo/entity-connections";
import { discoverEmailPurchaseConnections } from "~/server/domains/connection/service/email-purchase-discovery";
import { implementOperationDomain } from "~/server/operation-runtime/operation-domain.server";

export const connectionHandlers = implementOperationDomain(connectionContract, {
  read: async (context, source) => ({
    source,
    proposals: await readEntityConnections(context.db, source),
  }),
  discover: async (context, source) => {
    // Only Email and Purchase records have a discoverable relation (the Email
    // purchase link); other sources return their stored proposals unchanged.
    if (source.entityKind === "email" || source.entityKind === "purchase")
      await discoverEmailPurchaseConnections(context.db, source);
    return {
      source,
      proposals: await readEntityConnections(context.db, source),
      discoveryRunId: null,
    };
  },
});
