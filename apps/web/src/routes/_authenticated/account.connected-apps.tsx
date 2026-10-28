import type { ConnectedApp } from "@cubby/schemas/oauth";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import { useActionMutation } from "~/entity/hooks/use-action-mutation";
import { Page } from "~/entity/page/page";
import RTable from "~/entity/table/table";
import { OrphanedClientMaintenance } from "~/features/account/orphaned-client-maintenance";
import { oauth } from "~/integrations/tanstack-query/domains/oauth";
import { pageTitle } from "~/lib/page-title";
import { DateDisplay } from "~/ui/common/date-display";
import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
} from "~/ui/data-table/table-features";
import { attachCubbyColumnMeta } from "~/ui/data-table/table-meta";
import { useLocalTable } from "~/ui/data-table/use-local-table";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { Row, Stack } from "~/ui/layout";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/ui/primitives/alert-dialog";
import { Badge } from "~/ui/primitives/badge";
import { Button } from "~/ui/primitives/button";

// A static sibling of /account/$accountView: TanStack ranks literal segments
// above dynamic ones, so this wins over the better-auth-ui catch-all rather
// than rendering as an unknown account view.
export const Route = createFileRoute("/_authenticated/account/connected-apps")({
  component: ConnectedAppsPage,
  head: () => ({ meta: [{ title: pageTitle("Connected apps") }] }),
});

function ConnectedAppsPage() {
  const [pendingRevoke, setPendingRevoke] = useState<{
    consentId: string;
    label: string;
  } | null>(null);

  const {
    data: apps,
    isLoading,
    error,
    refetch,
  } = useQuery(oauth.listConnectedApps.queryOptions(null));

  const {
    data: orphanCount,
    error: orphanError,
    refetch: refetchOrphanCount,
  } = useQuery(oauth.countOrphanedClients.queryOptions(null));

  const revoke = useActionMutation({
    mutationFn: oauth.revokeConnectedApp.mutationOptions,
    success: "Access revoked",
    onSuccess: () => setPendingRevoke(null),
  });

  const prune = useActionMutation({
    mutationFn: oauth.pruneOrphanedClients.mutationOptions,
    success: (data) =>
      `Removed ${data.deleted.length} abandoned registration(s)`,
  });

  return (
    <Page variant="list" title="Connected apps">
      <p className="max-w-prose text-sm text-muted-foreground">
        Applications you've authorized to reach Cubby's MCP API over OAuth.
        Revoking kills the app's tokens immediately; it can reconnect by signing
        in again.
      </p>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : error ? (
        <Stack gap="sm">
          <ErrorDisplay error={error} />
          <Button variant="outline" onClick={() => void refetch()}>
            Retry connected apps
          </Button>
        </Stack>
      ) : !apps?.length ? (
        <p className="max-w-prose text-sm text-muted-foreground">
          Nothing connected. Add Cubby as a connector in Claude (or any MCP
          client) pointing at <code>/api/mcp</code> to authorize one.
        </p>
      ) : (
        <ConnectedAppsTable
          apps={apps}
          onRevoke={(app) =>
            setPendingRevoke({
              consentId: app.consentId,
              label: app.name ?? app.clientId,
            })
          }
        />
      )}

      <OrphanedClientMaintenance
        count={orphanCount}
        error={orphanError}
        isCleaning={prune.isPending}
        onCleanup={() => prune.mutate(null)}
        onRetry={() => void refetchOrphanCount()}
      />

      <AlertDialog
        open={pendingRevoke !== null}
        onOpenChange={(open) => !open && setPendingRevoke(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke {pendingRevoke?.label}?</AlertDialogTitle>
            <AlertDialogDescription>
              Its access and refresh tokens are revoked immediately and it loses
              access to your data. Reconnecting requires signing in and granting
              consent again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={revoke.isPending}
              onClick={() => {
                if (pendingRevoke) {
                  revoke.mutate({ consentId: pendingRevoke.consentId });
                }
              }}
            >
              {revoke.isPending ? "Revoking…" : "Revoke"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Page>
  );
}

const appHelper = createCubbyColumnHelper<ConnectedApp>();
const appId = (app: ConnectedApp) => app.consentId;
const appSearch = {
  text: (app: ConnectedApp) =>
    [app.name, app.clientId, ...app.scopes].join(" "),
  placeholder: "Search connected apps",
};
function ConnectedAppsTable({
  apps,
  onRevoke,
}: {
  apps: ConnectedApp[];
  onRevoke: (app: ConnectedApp) => void;
}) {
  const columns = useMemo(
    () =>
      createCubbyColumnCollection<ConnectedApp>((add) => {
        add(
          appHelper.accessor((app) => app.name ?? "Unnamed client", {
            id: "app",
            header: "App",
            size: 220,
            meta: attachCubbyColumnMeta<ConnectedApp>({
              mobile: { slot: "title", priority: 0 },
            }),
          }),
        );
        add(
          appHelper.accessor("clientId", {
            header: "Client ID",
            size: 220,
            meta: attachCubbyColumnMeta<ConnectedApp>({
              mono: true,
              mobile: { slot: "subtitle", priority: 0 },
            }),
          }),
        );
        add(
          appHelper.accessor((app) => app.scopes.join(" "), {
            id: "scopes",
            header: "Scopes",
            size: 260,
            meta: attachCubbyColumnMeta<ConnectedApp>({
              mobile: { slot: "meta", priority: 1 },
            }),
            cell: ({ row }) => (
              <Row gap="xs" wrap>
                {row.original.scopes.map((scope) => (
                  <Badge key={scope} variant="secondary">
                    {scope}
                  </Badge>
                ))}
              </Row>
            ),
          }),
        );
        add(
          appHelper.accessor("grantedAt", {
            header: "Granted",
            size: 150,
            meta: attachCubbyColumnMeta<ConnectedApp>({
              mobile: { slot: "meta", priority: 2 },
            }),
            cell: ({ row }) =>
              row.original.grantedAt ? (
                <DateDisplay timestamp={row.original.grantedAt} />
              ) : (
                "—"
              ),
          }),
        );
        add(
          appHelper.accessor("lastActiveAt", {
            header: "Last active",
            size: 150,
            meta: attachCubbyColumnMeta<ConnectedApp>({
              mobile: { slot: "meta", priority: 3 },
            }),
            cell: ({ row }) =>
              row.original.lastActiveAt ? (
                <DateDisplay timestamp={row.original.lastActiveAt} />
              ) : (
                "never"
              ),
          }),
        );
        add(
          appHelper.accessor("activeTokens", {
            header: "Active tokens",
            size: 100,
            meta: attachCubbyColumnMeta<ConnectedApp>({
              numeric: true,
              mobile: { slot: "trailing", priority: 0 },
            }),
          }),
        );
        add(
          appHelper.display({
            id: "actions",
            header: "Actions",
            size: 100,
            meta: attachCubbyColumnMeta<ConnectedApp>({
              entityColumnRole: "action",
              mobile: { slot: "actions", priority: 0 },
            }),
            cell: ({ row }) => (
              <Button
                variant="destructive"
                size="sm"
                onClick={() => onRevoke(row.original)}
              >
                Revoke
              </Button>
            ),
          }),
        );
      }),
    [onRevoke],
  );
  const table = useLocalTable({
    rows: apps,
    columns,
    getRowId: appId,
    search: appSearch,
  });
  return (
    <RTable
      table={table}
      embedded
      ariaLabel="Connected apps"
      withoutImages="OAuth consents have client names and scopes, not household record images."
    />
  );
}
