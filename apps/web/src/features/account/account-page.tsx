import { getErrorMessage } from "@cubby/shared";
import { DesktopIcon } from "@phosphor-icons/react/dist/csr/Desktop";
import { KeyIcon } from "@phosphor-icons/react/dist/csr/Key";
import { PlugIcon } from "@phosphor-icons/react/dist/csr/Plug";
import { ShieldCheckIcon } from "@phosphor-icons/react/dist/csr/ShieldCheck";
import { UserIcon } from "@phosphor-icons/react/dist/csr/User";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

import { Page } from "~/entity/page/page";
import {
  ApiKeySettings,
  ConnectedAppsSettings,
  SessionSettings,
} from "~/features/account/account-access";
import {
  authAccountsQuery,
  authApiKeysQuery,
  authSessionsQuery,
  unwrapAuth,
} from "~/features/account/account-queries";
import { oauth } from "~/integrations/tanstack-query/generated/domains/oauth.gen";
import { authClient } from "~/lib/auth-client";
import { hasGmailReadonlyScope } from "~/lib/google-auth";
import { GMAIL_READONLY_SCOPE } from "~/lib/google-auth-constants";
import { IndexedSections } from "~/ui/data-table/indexed-sections";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { FormFieldGroup } from "~/ui/forms/form-field-group";
import { Row } from "~/ui/layout";
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
import { Avatar, AvatarFallback, AvatarImage } from "~/ui/primitives/avatar";
import { Button } from "~/ui/primitives/button";
import { Input } from "~/ui/primitives/input";
import { RecordList, RecordRow } from "~/ui/records/record-list";
import { DateDisplay } from "~/ui/values/date-display";

export function AccountPage() {
  const sessions = useQuery(authSessionsQuery);
  const apps = useQuery(oauth.listConnectedApps.queryOptions(null));
  const apiKeys = useQuery(authApiKeysQuery);

  return (
    <Page variant="list" title="Account">
      <IndexedSections
        groups={[
          {
            id: "detail-group-identity",
            title: "Identity",
            sections: [
              {
                id: "profile",
                title: "Profile",
                icon: UserIcon,
                content: <ProfileSettings />,
              },
              {
                id: "sign-in",
                title: "Sign-in",
                icon: ShieldCheckIcon,
                description: "How you prove it's you.",
                content: <SignInSettings />,
              },
            ],
          },
          {
            id: "detail-group-access",
            title: "Access",
            sections: [
              {
                id: "sessions",
                title: "Sessions",
                icon: DesktopIcon,
                description: "Browsers and apps signed in as you.",
                count: sessions.data?.length,
                content: <SessionSettings sessions={sessions} />,
              },
              {
                id: "connected-apps",
                title: "Connected apps",
                icon: PlugIcon,
                description:
                  "MCP clients you authorized over OAuth. Revoking ends their tokens at once; they can reconnect by signing in again.",
                count: apps.data?.length,
                content: <ConnectedAppsSettings apps={apps} />,
              },
              {
                id: "api-keys",
                title: "API keys",
                icon: KeyIcon,
                description:
                  "Keys for scripts and the HTTP API. Each key acts as you.",
                count: apiKeys.data?.length,
                overflowVisible: true,
                content: <ApiKeySettings apiKeys={apiKeys} />,
              },
            ],
          },
        ]}
      />
    </Page>
  );
}

function initials(name: string | null | undefined) {
  if (!name) return "?";
  return name
    .split(" ")
    .map((part) => part[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

function ProfileSettings() {
  const session = authClient.useSession();
  const user = session.data?.user;
  const [draft, setDraft] = useState<string | null>(null);
  const name = draft ?? user?.name ?? "";
  const dirty = draft !== null && draft.trim() !== (user?.name ?? "");

  const save = useMutation({
    mutationFn: (next: string) =>
      unwrapAuth(authClient.updateUser({ name: next })),
    onSuccess: async () => {
      await session.refetch();
      setDraft(null);
      toast.success("Name updated");
    },
  });

  if (!user) return null;
  return (
    <Row align="start" gap="lg" className="max-md:flex-col">
      <Avatar size="lg">
        {user.image && <AvatarImage src={user.image} alt="" />}
        <AvatarFallback>{initials(user.name)}</AvatarFallback>
      </Avatar>
      <form
        className="grid w-full max-w-md gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (dirty) save.mutate(name.trim());
        }}
      >
        <FormFieldGroup label="Name" htmlFor="account-name">
          <Row gap="sm">
            <Input
              id="account-name"
              value={name}
              autoComplete="name"
              onChange={(event) => setDraft(event.target.value)}
            />
            {dirty ? (
              <Button type="submit" disabled={save.isPending || !name.trim()}>
                {save.isPending ? "Saving…" : "Save"}
              </Button>
            ) : null}
          </Row>
        </FormFieldGroup>
        <FormFieldGroup
          label="Email"
          htmlFor="account-email"
          description="Your avatar comes from your Google account."
        >
          <Input id="account-email" value={user.email} readOnly disabled />
        </FormFieldGroup>
      </form>
    </Row>
  );
}

function SignInSettings() {
  const accounts = useQuery(authAccountsQuery);
  if (accounts.isError)
    return (
      <ErrorDisplay
        error={accounts.error}
        title="Sign-in methods could not be loaded"
        onRetry={() => void accounts.refetch()}
      />
    );
  const credential = accounts.data?.find(
    (account) => account.providerId === "credential",
  );
  const google = accounts.data?.find(
    (account) => account.providerId === "google",
  );
  return (
    <RecordList
      aria-label="Sign-in methods"
      state={accounts.isPending ? { status: "pending", rows: 2 } : undefined}
    >
      <PasswordRow hasPassword={credential !== undefined} />
      <GoogleRow
        accountId={google?.id}
        linkedAt={google?.createdAt}
        gmail={hasGmailReadonlyScope(google?.scopes)}
        onUnlinked={async () => void (await accounts.refetch())}
      />
    </RecordList>
  );
}

function PasswordRow({ hasPassword }: { hasPassword: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <RecordRow
        leading={<KeyIcon aria-hidden className="size-4" />}
        primary={<span className="font-medium">Password</span>}
        secondary={
          hasPassword
            ? "Email and password sign-in is set up."
            : "No password set; you sign in with Google."
        }
        actions={
          hasPassword ? (
            <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
              Change
            </Button>
          ) : null
        }
      />
      <ChangePasswordDialog open={open} onOpenChange={setOpen} />
    </>
  );
}

const MIN_PASSWORD_LENGTH = 8;

function ChangePasswordDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const change = useMutation({
    mutationFn: () =>
      unwrapAuth(
        authClient.changePassword({
          currentPassword: current,
          newPassword: next,
        }),
      ),
    onSuccess: () => {
      toast.success("Password changed");
      close(false);
    },
  });
  const close = (nextOpen: boolean) => {
    if (!nextOpen) {
      setCurrent("");
      setNext("");
      change.reset();
    }
    onOpenChange(nextOpen);
  };
  const tooShort = next.length > 0 && next.length < MIN_PASSWORD_LENGTH;

  return (
    <Overlay
      open={open}
      onOpenChange={close}
      title="Change password"
      description="Other sessions stay signed in; revoke them under Sessions."
      error={change.error ? getErrorMessage(change.error) : undefined}
      primary={{
        label: "Change password",
        pendingLabel: "Changing…",
        form: "change-password-form",
        pending: change.isPending,
        disabled: !current || next.length < MIN_PASSWORD_LENGTH,
      }}
    >
      <form
        id="change-password-form"
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          change.mutate();
        }}
      >
        <FormFieldGroup label="Current password" htmlFor="current-password">
          <Input
            id="current-password"
            type="password"
            autoComplete="current-password"
            required
            value={current}
            onChange={(event) => setCurrent(event.target.value)}
          />
        </FormFieldGroup>
        <FormFieldGroup
          label="New password"
          htmlFor="new-password"
          invalid={tooShort}
          description={`At least ${MIN_PASSWORD_LENGTH} characters.`}
        >
          <Input
            id="new-password"
            type="password"
            autoComplete="new-password"
            required
            minLength={MIN_PASSWORD_LENGTH}
            aria-invalid={tooShort || undefined}
            value={next}
            onChange={(event) => setNext(event.target.value)}
          />
        </FormFieldGroup>
      </form>
    </Overlay>
  );
}

function GoogleRow({
  accountId,
  linkedAt,
  gmail,
  onUnlinked,
}: {
  accountId: string | undefined;
  linkedAt: Date | undefined;
  gmail: boolean;
  onUnlinked: () => Promise<void>;
}) {
  const linked = accountId !== undefined;
  const [confirmUnlink, setConfirmUnlink] = useState(false);
  const link = useMutation({
    // Navigates to Google on success; the account list refreshes on return.
    mutationFn: () =>
      unwrapAuth(
        authClient.linkSocial({
          provider: "google",
          callbackURL: "/account",
          scopes: [GMAIL_READONLY_SCOPE],
        }),
      ),
  });
  const unlink = useMutation({
    mutationFn: (id: string) =>
      unwrapAuth(authClient.unlinkAccount({ accountId: id })),
    onSuccess: async () => {
      setConfirmUnlink(false);
      toast.success("Google unlinked");
      await onUnlinked();
    },
  });

  return (
    <>
      <RecordRow
        leading={<GoogleMark />}
        primary={<span className="font-medium">Google</span>}
        secondary={
          linked ? (
            <>
              {gmail
                ? "Linked with read-only Gmail access"
                : "Linked; read-only Gmail access is missing"}
              {linkedAt ? (
                <>
                  {" · since "}
                  <DateDisplay timestamp={linkedAt} />
                </>
              ) : null}
            </>
          ) : (
            "Not linked"
          )
        }
        actions={
          linked ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setConfirmUnlink(true)}
            >
              Unlink
            </Button>
          ) : (
            <Button
              size="sm"
              disabled={link.isPending}
              onClick={() => link.mutate()}
            >
              {link.isPending ? "Opening Google…" : "Link"}
            </Button>
          )
        }
      />
      <AlertDialog open={confirmUnlink} onOpenChange={setConfirmUnlink}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Unlink Google?</AlertDialogTitle>
            <AlertDialogDescription>
              You can no longer sign in with Google, and Gmail order discovery
              stops until you link it again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={unlink.isPending}
              onClick={() => accountId && unlink.mutate(accountId)}
            >
              {unlink.isPending ? "Unlinking…" : "Unlink"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function GoogleMark() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="size-4">
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1Z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23Z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.1A6.6 6.6 0 0 1 5.5 12c0-.73.13-1.44.34-2.1V7.06H2.18A11 11 0 0 0 1 12c0 1.78.43 3.45 1.18 4.94l3.66-2.84Z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15A10.95 10.95 0 0 0 12 1 11 11 0 0 0 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52Z"
      />
    </svg>
  );
}
