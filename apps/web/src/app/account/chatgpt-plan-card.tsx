import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { z } from "zod";

import {
  CHATGPT_USAGE_URL,
  chatGptModel,
  chatGptStatus,
} from "~/lib/chatgpt-plan";
import { copyTextWithToast } from "~/lib/clipboard";
import { getErrorMessage } from "~/lib/error-utils";
import { useHydrated } from "~/ui/hooks/useHydrated";
import { Row, Stack } from "~/ui/layout";
import { Button } from "~/ui/primitives/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/ui/primitives/card";
import { StatusText } from "~/ui/primitives/status-text";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/ui/primitives/table";

const STATUS_KEY = ["chatgpt", "status"];
const DISCONNECTED = z.object({ disconnected: z.boolean() });
const MODEL_KEY = ["chatgpt", "models"];
const modelList = z.array(chatGptModel);
const responseError = z.object({ error: z.string() });

async function request<T>(
  schema: z.ZodType<T>,
  path = "",
  method = "GET",
): Promise<T> {
  const response = await fetch(`/api/ai/chatgpt${path}`, { method });
  const body: unknown = await response.json();
  if (!response.ok) throw new Error(responseError.parse(body).error);
  return schema.parse(body);
}

export function ChatGptPlanCard() {
  const hydrated = useHydrated();
  const [setup, setSetup] = useState(false);
  const client = useQueryClient();
  const status = useQuery({
    queryKey: STATUS_KEY,
    queryFn: () => request(chatGptStatus),
    enabled: hydrated,
  });
  const connected = status.data?.connected === true;
  const models = useQuery({
    queryKey: MODEL_KEY,
    queryFn: () => request(modelList, "?models"),
    enabled: hydrated && connected && !status.data?.needsReauthorization,
    retry: false,
  });
  const disconnect = useMutation({
    mutationFn: () => request(DISCONNECTED, "", "DELETE"),
    onSuccess: () => {
      client.removeQueries({ queryKey: MODEL_KEY });
      client.setQueryData(STATUS_KEY, {
        connected: false,
        email: null,
        needsReauthorization: false,
      });
      setSetup(false);
    },
  });
  const command = hydrated
    ? `pnpm chatgpt:connect --url ${window.location.origin}`
    : "";

  return (
    <Card className="max-md:border-x-0" data-testid="chatgpt-plan">
      <CardHeader>
        <CardTitle as="h2">ChatGPT plan</CardTitle>
        <CardDescription>
          Use your ChatGPT subscription for Cubby’s OpenAI tasks and
          purchase-import agent. Cubby keeps its current Luna and Sol models.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Stack gap="md">
          {!hydrated || status.isPending ? (
            <StatusText>Checking ChatGPT connection…</StatusText>
          ) : status.isError ? (
            <Stack gap="sm">
              <StatusText tone="destructive">
                {getErrorMessage(status.error)}
              </StatusText>
              <Button variant="outline" onClick={() => void status.refetch()}>
                Retry connection
              </Button>
            </Stack>
          ) : connected ? (
            <>
              <Row align="center" justify="between" gap="sm" wrap>
                <div className="min-w-0 text-sm">
                  <p className="font-medium">
                    {status.data?.needsReauthorization
                      ? "ChatGPT needs reconnection"
                      : "Using ChatGPT plan"}
                  </p>
                  <p className="break-words text-muted-foreground">
                    {status.data?.email}
                  </p>
                </div>
                <Button variant="outline" onClick={() => setSetup(true)}>
                  Reconnect ChatGPT
                </Button>
                <Button
                  variant="outline"
                  disabled={disconnect.isPending}
                  onClick={() => disconnect.mutate()}
                >
                  {disconnect.isPending
                    ? "Disconnecting…"
                    : "Disconnect ChatGPT"}
                </Button>
              </Row>
              <p className="text-sm text-muted-foreground">
                This connection powers the household’s Workers calls.
                Subscription limits apply. Embeddings and other providers retain
                their existing billing.
              </p>
              <Row align="center" justify="between" gap="sm" wrap>
                <a
                  className="inline-flex min-h-11 items-center text-sm underline underline-offset-4"
                  href={CHATGPT_USAGE_URL}
                  target="_blank"
                  rel="noreferrer"
                >
                  Manage usage
                </a>
                <Button
                  variant="outline"
                  disabled={models.isFetching}
                  onClick={() => void models.refetch()}
                >
                  Refresh models
                </Button>
              </Row>
              <div>
                <h3 className="mb-2 text-sm font-medium">Available models</h3>
                <AvailableModels
                  models={models.data}
                  pending={models.isPending}
                  error={models.error}
                  needsReauthorization={
                    status.data?.needsReauthorization ?? false
                  }
                />
              </div>
            </>
          ) : (
            <Row align="center" justify="between" gap="sm" wrap>
              <StatusText>Not connected.</StatusText>
              <Button onClick={() => setSetup(true)}>
                Continue with ChatGPT
              </Button>
            </Row>
          )}
          {setup ? (
            <Stack gap="sm">
              <p className="text-sm">
                From your local Cubby checkout, run the command below. It asks
                for a Cubby API key from Account → API keys, then opens ChatGPT
                sign-in in your browser. Credentials stay on Workers after
                setup; your Mac can close.
              </p>
              <code className="rounded-md bg-muted p-3 text-xs break-all">
                {command}
              </code>
              <Row gap="sm" wrap>
                <Button
                  variant="outline"
                  onClick={() =>
                    void copyTextWithToast(command, "Connection command copied")
                  }
                >
                  Copy command
                </Button>
                <Button variant="outline" onClick={() => void status.refetch()}>
                  Check connection
                </Button>
              </Row>
            </Stack>
          ) : null}
          {disconnect.isError ? (
            <StatusText tone="destructive">
              {getErrorMessage(disconnect.error)}
            </StatusText>
          ) : null}
        </Stack>
      </CardContent>
    </Card>
  );
}

function AvailableModels({
  models,
  pending,
  error,
  needsReauthorization,
}: {
  models: z.infer<typeof modelList> | undefined;
  pending: boolean;
  error: Error | null;
  needsReauthorization: boolean;
}) {
  return (
    <>
      {" "}
      {needsReauthorization ? (
        <StatusText>
          Reconnect ChatGPT to load models and resume tasks.
        </StatusText>
      ) : pending ? (
        <StatusText>Loading available models…</StatusText>
      ) : error !== null ? (
        <StatusText tone="destructive">{getErrorMessage(error)}</StatusText>
      ) : models?.length ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Model</TableHead>
              <TableHead>Model ID</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {models.map((model) => (
              <TableRow key={model.slug}>
                <TableCell className="break-words whitespace-normal">
                  {model.display_name}
                </TableCell>
                <TableCell className="font-mono break-all whitespace-normal">
                  {model.slug}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : (
        <StatusText>No models are available for this account.</StatusText>
      )}
    </>
  );
}
