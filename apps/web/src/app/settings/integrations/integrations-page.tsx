import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  Bug,
  CheckCircle,
  ExternalLink,
  Unlink,
  Wrench,
  XCircle,
} from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";
import { ColoredAlert } from "~/components/common/colored-alert";
import { Button } from "~/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Spinner } from "~/components/ui/spinner";
import { useTRPC } from "~/trpc/react";

export function IntegrationsPage() {
  const sheetUrlId = useId();
  const api = useTRPC();
  const queryClient = useQueryClient();
  const [sheetUrl, setSheetUrl] = useState("");

  // Get current connection status
  const { data: status, isLoading: statusLoading } = useQuery(
    api.googleSheets.getConnectionStatus.queryOptions(),
  );

  // Test connection mutation
  const testConnectionMutation = useMutation(
    api.googleSheets.testConnection.mutationOptions({
      onSuccess: (result) => {
        if (result.success) {
          toast.success(`Connected to "${result.sheetName}"`);
        } else {
          toast.error(result.error ?? "Failed to connect");
        }
      },
      onError: (error) => {
        toast.error(error.message);
      },
    }),
  );

  // Update connection mutation
  const updateConnectionMutation = useMutation(
    api.googleSheets.updateSheetConnection.mutationOptions({
      onSuccess: () => {
        toast.success("Google Sheet connection saved");
        queryClient.invalidateQueries({
          queryKey: api.googleSheets.getConnectionStatus.queryKey(),
        });
        setSheetUrl("");
      },
      onError: (error) => {
        toast.error(error.message);
      },
    }),
  );

  const handleTestConnection = () => {
    if (!sheetUrl) {
      toast.error("Please enter a Google Sheet URL");
      return;
    }
    testConnectionMutation.mutate({ sheetUrl });
  };

  const handleSaveConnection = () => {
    if (!sheetUrl) {
      toast.error("Please enter a Google Sheet URL");
      return;
    }
    // Test first, then save if successful
    testConnectionMutation.mutate(
      { sheetUrl },
      {
        onSuccess: (result) => {
          if (result.success) {
            updateConnectionMutation.mutate({ sheetUrl });
          }
        },
      },
    );
  };

  const handleDisconnect = () => {
    updateConnectionMutation.mutate({ sheetUrl: null });
  };

  // Repair schema mutation
  const repairSchemaMutation = useMutation(
    api.googleSheets.repairSheetSchema.mutationOptions({
      onSuccess: (result) => {
        toast.success(result.message);
      },
      onError: (error) => {
        toast.error(error.message);
      },
    }),
  );

  const handleRepairSchema = () => {
    repairSchemaMutation.mutate();
  };

  const isConnecting =
    testConnectionMutation.isPending || updateConnectionMutation.isPending;

  return (
    <div className="container mx-auto py-6">
      <div className="mb-6">
        <h1 className="font-bold text-2xl">Integrations</h1>
        <p className="text-muted-foreground">
          Connect external services to sync your inventory data.
        </p>
      </div>

      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <svg
              aria-hidden="true"
              className="h-5 w-5"
              viewBox="0 0 24 24"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              <path
                d="M19.5 3H4.5C3.67157 3 3 3.67157 3 4.5V19.5C3 20.3284 3.67157 21 4.5 21H19.5C20.3284 21 21 20.3284 21 19.5V4.5C21 3.67157 20.3284 3 19.5 3Z"
                fill="#0F9D58"
              />
              <path d="M3 9H21" stroke="white" strokeWidth="0.5" />
              <path d="M3 15H21" stroke="white" strokeWidth="0.5" />
              <path d="M9 3V21" stroke="white" strokeWidth="0.5" />
            </svg>
            Google Sheets
          </CardTitle>
          <CardDescription>
            Sync inventory with a Google Sheet for bulk editing in a familiar
            spreadsheet interface.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
          {/* Configuration status */}
          {!status?.configured && (
            <ColoredAlert variant="warning">
              <p className="font-medium">Integration not configured</p>
              <p className="mt-1 text-xs">
                The Google Sheets integration requires server-side
                configuration. Contact your administrator to set up the service
                account credentials.
              </p>
            </ColoredAlert>
          )}

          {/* Current connection status */}
          {statusLoading ? (
            <div className="flex items-center gap-2 text-muted-foreground text-sm">
              <Spinner />
              Checking connection...
            </div>
          ) : status?.connected ? (
            <ColoredAlert variant="success">
              <div className="flex items-center gap-2 font-medium text-sm">
                <CheckCircle className="h-4 w-4" />
                Connected to &ldquo;{status.sheetName}&rdquo;
              </div>
              {status.lastSync && (
                <p className="mt-1 text-xs opacity-80">
                  Last synced: {new Date(status.lastSync).toLocaleString()}
                </p>
              )}
              <div className="mt-2 flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  render={
                    // biome-ignore lint/a11y/useAnchorContent: content provided via Button children
                    <a
                      href={`https://docs.google.com/spreadsheets/d/${status.sheetId}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    />
                  }
                  nativeButton={false}
                >
                  <ExternalLink className="h-3 w-3" />
                  Open Sheet
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleRepairSchema}
                  disabled={repairSchemaMutation.isPending}
                >
                  {repairSchemaMutation.isPending ? (
                    <Spinner size="sm" />
                  ) : (
                    <Wrench className="h-3 w-3" />
                  )}
                  Repair Schema
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  render={<Link to="/settings/integrations/debug" />}
                  nativeButton={false}
                >
                  <Bug className="h-3 w-3" />
                  Debug
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleDisconnect}
                  disabled={isConnecting}
                >
                  <Unlink className="h-3 w-3" />
                  Disconnect
                </Button>
              </div>
            </ColoredAlert>
          ) : status?.sheetId ? (
            <ColoredAlert variant="destructive">
              <div className="flex items-center gap-2 font-medium text-sm">
                <XCircle className="h-4 w-4" />
                Cannot access connected sheet
              </div>
              <p className="mt-1 text-xs opacity-80">
                The previously connected sheet is no longer accessible. It may
                have been deleted or the sharing was removed.
              </p>
              <Button
                variant="outline"
                size="sm"
                className="mt-2"
                onClick={handleDisconnect}
                disabled={isConnecting}
              >
                <Unlink className="h-3 w-3" />
                Clear Connection
              </Button>
            </ColoredAlert>
          ) : null}

          {/* Connect new sheet */}
          {status?.configured && !status?.connected && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor={sheetUrlId}>Google Sheet URL</Label>
                <Input
                  id={sheetUrlId}
                  type="url"
                  placeholder="https://docs.google.com/spreadsheets/d/..."
                  value={sheetUrl}
                  onChange={(e) => setSheetUrl(e.target.value)}
                />
              </div>

              {status.serviceAccountEmail && (
                <div className="rounded-md border bg-muted/50 p-3 text-xs">
                  <p className="font-medium">Setup instructions:</p>
                  <ol className="mt-1.5 list-inside list-decimal space-y-1 text-muted-foreground">
                    <li>Create or open a Google Sheet</li>
                    <li>
                      Click Share and add:{" "}
                      <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
                        {status.serviceAccountEmail}
                      </code>
                    </li>
                    <li>Give it Editor access</li>
                    <li>Paste the Sheet URL above</li>
                  </ol>
                </div>
              )}

              <div className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={handleTestConnection}
                  disabled={isConnecting || !sheetUrl}
                >
                  {testConnectionMutation.isPending && <Spinner size="sm" />}
                  Test Connection
                </Button>
                <Button
                  onClick={handleSaveConnection}
                  disabled={isConnecting || !sheetUrl}
                >
                  {updateConnectionMutation.isPending && <Spinner size="sm" />}
                  Connect Sheet
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
