import { z } from "zod";
import {
  runStartOperation,
  type StartOperationRequest,
} from "~/server/start-operation.server";
import {
  connectedAppsOut,
  countOrphanedOAuthClientsWorkflow,
  listConnectedAppsWorkflow,
  orphanedOAuthClientsOut,
  pruneOrphanedOAuthClientsOut,
  pruneOrphanedOAuthClientsWorkflow,
  revokeConnectedAppInput,
  revokeConnectedAppOut,
  revokeConnectedAppWorkflow,
} from "~/server/workflows/oauth.server";

export const listConnectedAppsForBrowser = async (options: {
  request: StartOperationRequest;
}) =>
  await runStartOperation({
    operation: "oauth.listConnectedApps",
    type: "query",
    input: undefined,
    inputSchema: z.undefined(),
    outputSchema: connectedAppsOut,
    request: options.request,
    run: (context) =>
      listConnectedAppsWorkflow(context.db, context.actorContext.userId),
  });

export const revokeConnectedAppForBrowser = async (options: {
  data: z.input<typeof revokeConnectedAppInput>;
  request: StartOperationRequest;
}) =>
  await runStartOperation({
    operation: "oauth.revokeConnectedApp",
    type: "mutation",
    input: options.data,
    inputSchema: revokeConnectedAppInput,
    outputSchema: revokeConnectedAppOut,
    request: options.request,
    run: (context, input) =>
      revokeConnectedAppWorkflow(
        context.db,
        context.actorContext.userId,
        input,
      ),
  });

export const countOrphanedOAuthClientsForBrowser = async (options: {
  request: StartOperationRequest;
}) =>
  await runStartOperation({
    operation: "oauth.countOrphanedClients",
    type: "query",
    input: undefined,
    inputSchema: z.undefined(),
    outputSchema: orphanedOAuthClientsOut,
    request: options.request,
    run: (context) => countOrphanedOAuthClientsWorkflow(context.db),
  });

export const pruneOrphanedOAuthClientsForBrowser = async (options: {
  request: StartOperationRequest;
}) =>
  await runStartOperation({
    operation: "oauth.pruneOrphanedClients",
    type: "mutation",
    input: undefined,
    inputSchema: z.undefined(),
    outputSchema: pruneOrphanedOAuthClientsOut,
    request: options.request,
    run: (context) => pruneOrphanedOAuthClientsWorkflow(context.db),
  });
