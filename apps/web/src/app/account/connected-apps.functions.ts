import {
  connectedAppsOut,
  orphanedOAuthClientsOut,
  pruneOrphanedOAuthClientsOut,
  type revokeConnectedAppInput,
  revokeConnectedAppOut,
} from "@cubby/schemas/oauth";
import { mutationOptions, queryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import type { z } from "zod";
import { startOperation } from "~/integrations/tanstack-query/start-transport";
import { markFreshReads } from "~/lib/fresh-read-marker";
import { queryKeys } from "~/lib/query-keys";
import { authenticatedStartServerFunction } from "~/server/middleware/entity-server-functions";
import * as oauthBrowser from "~/server/oauth-browser.server";

const listConnectedAppsTransport = createServerFn({ method: "GET" })
  .middleware([authenticatedStartServerFunction])
  .handler(
    async ({ context }) =>
      await oauthBrowser.listConnectedAppsForBrowser({
        request: context.startOperation,
      }),
  );

const revokeConnectedAppTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator(
    (input: unknown) => input as z.input<typeof revokeConnectedAppInput>,
  )
  .handler(
    async ({ data, context }) =>
      await oauthBrowser.revokeConnectedAppForBrowser({
        data,
        request: context.startOperation,
      }),
  );

const countOrphanedOAuthClientsTransport = createServerFn({ method: "GET" })
  .middleware([authenticatedStartServerFunction])
  .handler(
    async ({ context }) =>
      await oauthBrowser.countOrphanedOAuthClientsForBrowser({
        request: context.startOperation,
      }),
  );

const pruneOrphanedOAuthClientsTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .handler(
    async ({ context }) =>
      await oauthBrowser.pruneOrphanedOAuthClientsForBrowser({
        request: context.startOperation,
      }),
  );

const listConnectedAppsOperation = startOperation<
  null,
  z.output<typeof connectedAppsOut>
>({
  operation: "oauth.listConnectedApps",
  transport: (_input, { signal, headers }) =>
    listConnectedAppsTransport({ signal, headers }),
  parse: (result) => connectedAppsOut.parse(result),
});

const revokeConnectedAppOperation = startOperation<
  z.input<typeof revokeConnectedAppInput>,
  z.output<typeof revokeConnectedAppOut>
>({
  operation: "oauth.revokeConnectedApp",
  kind: "mutation",
  transport: (data, { headers }) =>
    revokeConnectedAppTransport({ data, headers }),
  parse: (result) => revokeConnectedAppOut.parse(result),
});

const countOrphanedOAuthClientsOperation = startOperation<
  null,
  z.output<typeof orphanedOAuthClientsOut>
>({
  operation: "oauth.countOrphanedClients",
  transport: (_input, { signal, headers }) =>
    countOrphanedOAuthClientsTransport({ signal, headers }),
  parse: (result) => orphanedOAuthClientsOut.parse(result),
});

const pruneOrphanedOAuthClientsOperation = startOperation<
  null,
  z.output<typeof pruneOrphanedOAuthClientsOut>
>({
  operation: "oauth.pruneOrphanedClients",
  kind: "mutation",
  transport: (_input, { headers }) =>
    pruneOrphanedOAuthClientsTransport({ headers }),
  parse: (result) => pruneOrphanedOAuthClientsOut.parse(result),
});

export const connectedAppsQueryOptions = () =>
  queryOptions({
    queryKey: [[...queryKeys.oauth.connectedApps]] as const,
    meta: listConnectedAppsOperation.meta,
    queryFn: ({ signal }) => listConnectedAppsOperation.call(null, { signal }),
  });

export const orphanedOAuthClientsQueryOptions = () =>
  queryOptions({
    queryKey: [[...queryKeys.oauth.orphaned]] as const,
    meta: countOrphanedOAuthClientsOperation.meta,
    queryFn: ({ signal }) =>
      countOrphanedOAuthClientsOperation.call(null, { signal }),
  });

export const revokeConnectedAppMutationOptions = () =>
  mutationOptions({
    mutationKey: [...queryKeys.oauth.connectedApps, "revoke"] as const,
    mutationFn: async (input: z.input<typeof revokeConnectedAppInput>) => {
      const result = await revokeConnectedAppOperation.call(input);
      markFreshReads();
      return result;
    },
    meta: revokeConnectedAppOperation.meta,
  });

export const pruneOrphanedOAuthClientsMutationOptions = () =>
  mutationOptions({
    mutationKey: [...queryKeys.oauth.orphaned, "prune"] as const,
    mutationFn: async () => {
      const result = await pruneOrphanedOAuthClientsOperation.call(null);
      markFreshReads();
      return result;
    },
    meta: pruneOrphanedOAuthClientsOperation.meta,
  });
