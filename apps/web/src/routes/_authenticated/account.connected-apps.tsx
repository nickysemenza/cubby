import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useActionMutation } from "~/app/_components/hooks/useActionMutation";
import { oauth } from "~/app/account/connected-apps.functions";
import { OrphanedClientMaintenance } from "~/app/account/orphaned-client-maintenance";
import { ErrorDisplay } from "~/components/feedback/error-display";
import { Row, Stack } from "~/components/layout";
import { Page } from "~/components/page/Page";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { pageTitle } from "~/lib/page-title";

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
      <p className="text-muted-foreground text-xs">
        Applications you've authorized to reach cubby's MCP API over OAuth.
        Revoking kills the app's tokens immediately; it can reconnect by signing
        in again.
      </p>

      {isLoading ? (
        <p className="text-muted-foreground text-xs">Loading…</p>
      ) : error ? (
        <Stack gap="sm">
          <ErrorDisplay error={error} />
          <Button variant="outline" onClick={() => void refetch()}>
            Retry connected apps
          </Button>
        </Stack>
      ) : !apps?.length ? (
        <p className="text-muted-foreground text-xs">
          Nothing connected. Add cubby as a connector in Claude (or any MCP
          client) pointing at <code>/api/mcp</code> to authorize one.
        </p>
      ) : (
        <Table className="table-auto">
          <TableHeader>
            <TableRow>
              <TableHead>App</TableHead>
              <TableHead>Scopes</TableHead>
              <TableHead>Granted</TableHead>
              <TableHead>Last active</TableHead>
              <TableHead>Active tokens</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {apps.map((app) => (
              <TableRow key={app.consentId}>
                <TableCell>
                  {/* block, not inline spans: Stack applies space-y, which
                      does nothing to inline children — they'd run together. */}
                  <Stack gap="tight">
                    <div className="font-medium">
                      {app.name ?? "Unnamed client"}
                    </div>
                    <div className="font-mono text-2xs text-slate">
                      {app.clientId}
                    </div>
                  </Stack>
                </TableCell>
                <TableCell className="whitespace-normal">
                  <Row gap="xs" wrap>
                    {app.scopes.map((scope) => (
                      <Badge key={scope} variant="secondary">
                        {scope}
                      </Badge>
                    ))}
                  </Row>
                </TableCell>
                <TableCell className="text-muted-foreground text-xs">
                  {app.grantedAt
                    ? new Date(app.grantedAt).toLocaleDateString()
                    : "—"}
                </TableCell>
                <TableCell className="text-muted-foreground text-xs">
                  {app.lastActiveAt
                    ? new Date(app.lastActiveAt).toLocaleString()
                    : "never"}
                </TableCell>
                <TableCell className="font-mono text-xs">
                  {app.activeTokens}
                </TableCell>
                <TableCell>
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() =>
                      setPendingRevoke({
                        consentId: app.consentId,
                        label: app.name ?? app.clientId,
                      })
                    }
                  >
                    Revoke
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
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
