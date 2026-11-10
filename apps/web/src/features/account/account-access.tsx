import type { ConnectedApp } from "@cubby/schemas/oauth";
import { getErrorMessage } from "@cubby/shared";
import { CopyIcon } from "@phosphor-icons/react/dist/csr/Copy";
import { DesktopIcon } from "@phosphor-icons/react/dist/csr/Desktop";
import { DeviceMobileIcon } from "@phosphor-icons/react/dist/csr/DeviceMobile";
import { KeyIcon } from "@phosphor-icons/react/dist/csr/Key";
import { PlugIcon } from "@phosphor-icons/react/dist/csr/Plug";
import { QuestionIcon } from "@phosphor-icons/react/dist/csr/Question";
import { TerminalIcon } from "@phosphor-icons/react/dist/csr/Terminal";
import {
  type UseQueryResult,
  useMutation,
  useQuery,
} from "@tanstack/react-query";
import { type ElementType, useState } from "react";
import { toast } from "sonner";

import { useActionMutation } from "~/entity/hooks/use-action-mutation";
import {
  API_KEY_CONFIG_ID,
  unwrapAuth,
} from "~/features/account/account-queries";
import { OrphanedClientMaintenance } from "~/features/account/orphaned-client-maintenance";
import { oauth } from "~/integrations/tanstack-query/generated/domains/oauth.gen";
import { authClient } from "~/lib/auth-client";
import { copyTextWithToast } from "~/lib/clipboard";
import { FormFieldGroup } from "~/ui/forms/form-field-group";
import { Row, Stack } from "~/ui/layout";
import { Overlay } from "~/ui/overlays/overlay";
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
import { Button } from "~/ui/primitives/button";
import { Input } from "~/ui/primitives/input";
import { RecordList, RecordRow } from "~/ui/records/record-list";
import { Badge } from "~/ui/reui/badge";
import { DateDisplay } from "~/ui/values/date-display";

import {
  compactIpAddress,
  describeSessionClient,
  type SessionClient,
} from "./session-client";

type Session = NonNullable<
  Awaited<ReturnType<typeof authClient.listSessions>>["data"]
>[number];
type ApiKey = NonNullable<
  Awaited<ReturnType<typeof authClient.apiKey.list>>["data"]
>["apiKeys"][number];

const CLIENT_ICONS = {
  phone: DeviceMobileIcon,
  computer: DesktopIcon,
  terminal: TerminalIcon,
  unknown: QuestionIcon,
} satisfies Record<SessionClient["kind"], ElementType>;

function listState(query: UseQueryResult<unknown>, title: string) {
  if (query.isPending) return { status: "pending" as const };
  if (query.isError)
    return {
      status: "error" as const,
      error: query.error,
      title,
      onRetry: () => void query.refetch(),
    };
  return { status: "success" as const };
}

/** A confirm dialog for one pending destructive action. */
function ConfirmDialog({
  title,
  description,
  action,
  pendingAction,
  pending,
  open,
  onOpenChange,
  onConfirm,
}: {
  title: string;
  description: string;
  action: string;
  pendingAction: string;
  pending: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={pending}
            onClick={onConfirm}
          >
            {pending ? pendingAction : action}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function SessionSettings({
  sessions,
}: {
  sessions: UseQueryResult<Session[]>;
}) {
  const currentId = authClient.useSession().data?.session.id;
  const [confirmOthers, setConfirmOthers] = useState(false);
  const refresh = () => sessions.refetch();

  const revoke = useMutation({
    mutationFn: (token: string) =>
      unwrapAuth(authClient.revokeSession({ token })),
    onSuccess: async () => {
      toast.success("Session revoked");
      await refresh();
    },
  });
  const revokeOthers = useMutation({
    mutationFn: () => unwrapAuth(authClient.revokeOtherSessions()),
    onSuccess: async () => {
      setConfirmOthers(false);
      toast.success("Signed out everywhere else");
      await refresh();
    },
  });

  const rows = [...(sessions.data ?? [])].sort(
    (a, b) =>
      Number(b.id === currentId) - Number(a.id === currentId) ||
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );
  const others = rows.filter((session) => session.id !== currentId).length;

  return (
    <Stack gap="sm">
      <RecordList
        aria-label="Sessions"
        state={listState(sessions, "Sessions could not be loaded")}
        columns={[
          { id: "active", label: "Last active" },
          { id: "signed-in", label: "Signed in" },
          { id: "expires", label: "Expires" },
        ]}
        empty="No active sessions."
      >
        {rows.map((session) => {
          const client = describeSessionClient(session.userAgent);
          const Icon = CLIENT_ICONS[client.kind];
          const current = session.id === currentId;
          return (
            <RecordRow
              key={session.id}
              leading={<Icon aria-hidden className="size-4" />}
              primary={
                <span
                  className="truncate font-medium"
                  title={session.userAgent ?? undefined}
                >
                  {client.label}
                </span>
              }
              secondary={
                <Row gap="xs" align="center">
                  {current ? (
                    <Badge variant="positive">This browser</Badge>
                  ) : null}
                  <span className="font-mono tabular-nums">
                    {compactIpAddress(session.ipAddress) ?? "No IP recorded"}
                  </span>
                </Row>
              }
              facts={[
                {
                  id: "active",
                  label: "Last active",
                  value: <DateDisplay timestamp={session.updatedAt} />,
                },
                {
                  id: "signed-in",
                  label: "Signed in",
                  value: <DateDisplay timestamp={session.createdAt} />,
                },
                {
                  id: "expires",
                  label: "Expires",
                  value: <DateDisplay timestamp={session.expiresAt} />,
                },
              ]}
              actions={
                current ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void authClient.signOut()}
                  >
                    Sign out
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={
                      revoke.isPending && revoke.variables === session.token
                    }
                    onClick={() => revoke.mutate(session.token)}
                  >
                    Revoke
                  </Button>
                )
              }
            />
          );
        })}
      </RecordList>
      {others > 0 ? (
        <div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setConfirmOthers(true)}
          >
            Sign out all other sessions
          </Button>
        </div>
      ) : null}
      <ConfirmDialog
        title={`Sign out ${others} other ${others === 1 ? "session" : "sessions"}?`}
        description="Every browser and app except this one is signed out at once and must sign in again. Connected apps and API keys are not affected."
        action="Sign out others"
        pendingAction="Signing out…"
        pending={revokeOthers.isPending}
        open={confirmOthers}
        onOpenChange={setConfirmOthers}
        onConfirm={() => revokeOthers.mutate()}
      />
    </Stack>
  );
}

function hostOf(uri: string | null) {
  if (!uri) return null;
  try {
    return new URL(uri).host;
  } catch {
    return uri;
  }
}

export function ConnectedAppsSettings({
  apps,
}: {
  apps: UseQueryResult<ConnectedApp[]>;
}) {
  const [pending, setPending] = useState<ConnectedApp | null>(null);
  const orphans = useQuery(oauth.countOrphanedClients.queryOptions(null));
  const revoke = useActionMutation({
    mutationFn: oauth.revokeConnectedApp.mutationOptions,
    success: "Access revoked",
    onSuccess: () => setPending(null),
  });
  const prune = useActionMutation({
    mutationFn: oauth.pruneOrphanedClients.mutationOptions,
    success: (data) =>
      `Removed ${data.deleted.length} abandoned registration(s)`,
  });

  return (
    <Stack gap="sm">
      <RecordList
        aria-label="Connected apps"
        state={listState(apps, "Connected apps could not be loaded")}
        columns={[
          { id: "granted", label: "Granted" },
          { id: "active", label: "Last active" },
          { id: "tokens", label: "Tokens" },
        ]}
        empty={
          <>
            Nothing connected. Add Cubby as a connector in Claude or any MCP
            client pointing at <code>/api/mcp</code> to authorize one.
          </>
        }
      >
        {(apps.data ?? []).map((app) => (
          <RecordRow
            key={app.consentId}
            leading={<PlugIcon aria-hidden className="size-4" />}
            primary={
              <span className="truncate font-medium" title={app.clientId}>
                {app.name ?? app.clientId}
              </span>
            }
            secondary={
              <Row gap="xs" wrap align="center">
                {hostOf(app.uri) ? <span>{hostOf(app.uri)}</span> : null}
                {app.scopes.map((scope) => (
                  <Badge key={scope} variant="secondary">
                    {scope}
                  </Badge>
                ))}
              </Row>
            }
            facts={[
              {
                id: "granted",
                label: "Granted",
                value: app.grantedAt ? (
                  <DateDisplay timestamp={app.grantedAt} />
                ) : (
                  "—"
                ),
              },
              {
                id: "active",
                label: "Last active",
                value: app.lastActiveAt ? (
                  <DateDisplay timestamp={app.lastActiveAt} />
                ) : (
                  "—"
                ),
              },
              {
                id: "tokens",
                label: "Tokens",
                value: app.activeTokens,
                className: "font-mono tabular-nums",
              },
            ]}
            actions={
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPending(app)}
              >
                Revoke
              </Button>
            }
          />
        ))}
      </RecordList>
      <OrphanedClientMaintenance
        count={orphans.data}
        error={orphans.error}
        isCleaning={prune.isPending}
        onCleanup={() => prune.mutate(null)}
        onRetry={() => void orphans.refetch()}
      />
      <ConfirmDialog
        title={`Revoke ${pending?.name ?? pending?.clientId ?? "app"}?`}
        description="Its access and refresh tokens are revoked immediately and it loses access to your data. Reconnecting requires signing in and granting consent again."
        action="Revoke"
        pendingAction="Revoking…"
        pending={revoke.isPending}
        open={pending !== null}
        onOpenChange={(open) => !open && setPending(null)}
        onConfirm={() =>
          pending && revoke.mutate({ consentId: pending.consentId })
        }
      />
    </Stack>
  );
}

export function ApiKeySettings({
  apiKeys,
}: {
  apiKeys: UseQueryResult<ApiKey[]>;
}) {
  const [creating, setCreating] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<ApiKey | null>(null);
  const remove = useMutation({
    mutationFn: (keyId: string) =>
      unwrapAuth(
        authClient.apiKey.delete({ keyId, configId: API_KEY_CONFIG_ID }),
      ),
    onSuccess: async () => {
      setPendingDelete(null);
      toast.success("API key deleted");
      await apiKeys.refetch();
    },
  });

  return (
    <Stack gap="sm">
      <RecordList
        aria-label="API keys"
        state={listState(apiKeys, "API keys could not be loaded")}
        columns={[
          { id: "created", label: "Created" },
          { id: "used", label: "Last used" },
          { id: "expires", label: "Expires" },
        ]}
        empty="No API keys."
      >
        {(apiKeys.data ?? []).map((key) => (
          <RecordRow
            key={key.id}
            leading={<KeyIcon aria-hidden className="size-4" />}
            primary={
              <span className="truncate font-medium">
                {key.name ?? "Unnamed key"}
              </span>
            }
            secondary={
              <span className="font-mono">
                {key.start ?? key.prefix ?? ""}…
              </span>
            }
            facts={[
              {
                id: "created",
                label: "Created",
                value: <DateDisplay timestamp={key.createdAt} />,
              },
              {
                id: "used",
                label: "Last used",
                value: key.lastRequest ? (
                  <DateDisplay timestamp={key.lastRequest} />
                ) : (
                  "Never"
                ),
              },
              {
                id: "expires",
                label: "Expires",
                value: key.expiresAt ? (
                  <DateDisplay timestamp={key.expiresAt} />
                ) : (
                  "Never"
                ),
              },
            ]}
            actions={
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPendingDelete(key)}
              >
                Delete
              </Button>
            }
          />
        ))}
      </RecordList>
      <div>
        <Button variant="outline" size="sm" onClick={() => setCreating(true)}>
          New API key
        </Button>
      </div>
      <CreateApiKeyDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={async () => void (await apiKeys.refetch())}
      />
      <ConfirmDialog
        title={`Delete ${pendingDelete?.name ?? "this key"}?`}
        description="Scripts using this key stop working immediately. This cannot be undone."
        action="Delete"
        pendingAction="Deleting…"
        pending={remove.isPending}
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
        onConfirm={() => pendingDelete && remove.mutate(pendingDelete.id)}
      />
    </Stack>
  );
}

function CreateApiKeyDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => Promise<void>;
}) {
  const [name, setName] = useState("");
  const create = useMutation({
    mutationFn: () =>
      unwrapAuth(
        authClient.apiKey.create({
          name: name.trim(),
          configId: API_KEY_CONFIG_ID,
        }),
      ),
    onSuccess: () => onCreated(),
  });
  const secret = create.data?.key;
  const close = (next: boolean) => {
    if (!next) {
      setName("");
      create.reset();
    }
    onOpenChange(next);
  };

  if (secret)
    return (
      <Overlay
        open={open}
        onOpenChange={close}
        title="Copy your new key"
        description="This is the only time the full key is shown. Store it somewhere safe."
        cancelLabel="Done"
      >
        <Row gap="sm">
          <Input
            aria-label="New API key"
            readOnly
            value={secret}
            className="font-mono"
            onFocus={(event) => event.currentTarget.select()}
          />
          <Button
            variant="outline"
            onClick={() => void copyTextWithToast(secret, "API key copied")}
          >
            <CopyIcon />
            Copy
          </Button>
        </Row>
      </Overlay>
    );
  return (
    <Overlay
      open={open}
      onOpenChange={close}
      title="New API key"
      description="The key acts as you and does not expire."
      error={create.error ? getErrorMessage(create.error) : undefined}
      primary={{
        label: "Create key",
        pendingLabel: "Creating…",
        form: "create-api-key-form",
        pending: create.isPending,
        disabled: !name.trim(),
      }}
    >
      <form
        id="create-api-key-form"
        onSubmit={(event) => {
          event.preventDefault();
          create.mutate();
        }}
      >
        <FormFieldGroup label="Name" htmlFor="api-key-name">
          <Input
            id="api-key-name"
            required
            placeholder="e.g. Pantry sync script"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </FormFieldGroup>
      </form>
    </Overlay>
  );
}
