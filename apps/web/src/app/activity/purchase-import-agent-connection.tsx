import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Row } from "~/components/layout";
import { Button } from "~/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { StatusText } from "~/components/ui/status-text";
import { getErrorMessage } from "~/lib/error-utils";
import { readJsonOrThrow } from "~/lib/http-error";
import {
  type PurchaseAgentConnectionStatus,
  purchaseImportAgentOAuthStatus,
} from "~/lib/purchase-import-run-detail";

/** Connection state is owned by Activity because it governs who may run imports. */
export function PurchaseImportAgentConnection({
  feedback,
}: {
  feedback?: PurchaseAgentConnectionStatus;
}) {
  const queryClient = useQueryClient();
  const access = useQuery({
    queryKey: ["purchase-import", "agent-oauth"],
    queryFn: async () => {
      const response = await fetch("/api/import/agent/oauth/status");
      return readJsonOrThrow(
        response,
        purchaseImportAgentOAuthStatus,
        "Purchase import agent access could not load.",
      );
    },
  });
  const disconnect = useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/import/agent/oauth/status", {
        method: "DELETE",
      });
      return readJsonOrThrow(
        response,
        purchaseImportAgentOAuthStatus,
        "Purchase import agent access could not be disconnected.",
        { method: "DELETE" },
      );
    },
    onSuccess: (data) => {
      queryClient.setQueryData(["purchase-import", "agent-oauth"], data);
      toast.success("Purchase import agent disconnected");
    },
  });
  return (
    <Card className="max-w-2xl">
      <CardHeader>
        <CardTitle>Purchase import agent</CardTitle>
        <CardDescription>
          Authorize the private agent to continue an interactive vendor import
          on your behalf.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {feedback === "authorized" ? (
          <StatusText tone="positive">
            Purchase import agent authorized.
          </StatusText>
        ) : feedback === "denied" ? (
          <StatusText tone="destructive">
            Purchase import authorization was not completed.
          </StatusText>
        ) : feedback === "failed" ? (
          <StatusText tone="destructive">
            Authorization expired or could not be completed. Authorize the agent
            again.
          </StatusText>
        ) : feedback === "dispatch_failed" ? (
          <StatusText tone="destructive">
            The agent is authorized, but some work could not be dispatched. Open
            the affected run and retry dispatch.
          </StatusText>
        ) : null}
        {access.isLoading ? (
          <StatusText>Checking agent access…</StatusText>
        ) : access.isError ? (
          <StatusText tone="destructive">
            {getErrorMessage(access.error)}
          </StatusText>
        ) : access.data?.authorized ? (
          <Row align="center" justify="between" gap="sm" wrap>
            <span className="text-sm text-muted-foreground">
              Authorized
              {access.data.expiresAt
                ? ` until ${new Date(access.data.expiresAt).toLocaleString()}`
                : ""}
              .
            </span>
            <Button
              type="button"
              variant="outline"
              onClick={() => disconnect.mutate()}
              disabled={disconnect.isPending}
            >
              Disconnect agent
            </Button>
          </Row>
        ) : (
          <Row align="center" justify="between" gap="sm" wrap>
            <span className="text-sm text-muted-foreground">
              Not authorized.
            </span>
            <Button
              render={
                <a
                  href="/api/import/agent/oauth/start"
                  aria-label="Authorize purchase import agent"
                />
              }
            >
              Authorize agent
            </Button>
          </Row>
        )}
        {disconnect.isError ? (
          <StatusText tone="destructive">
            {getErrorMessage(disconnect.error)}
          </StatusText>
        ) : null}
      </CardContent>
    </Card>
  );
}
