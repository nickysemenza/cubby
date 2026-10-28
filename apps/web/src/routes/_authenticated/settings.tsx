import { purchaseAgentConnectionStatus } from "@cubby/schemas/purchase-import-debug";
import { getErrorMessage } from "@cubby/shared";
import { ArrowClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowClockwise";
import { CalendarIcon } from "@phosphor-icons/react/dist/csr/Calendar";
import { ClockIcon } from "@phosphor-icons/react/dist/csr/Clock";
import { CoinsIcon } from "@phosphor-icons/react/dist/csr/Coins";
import { CopyIcon } from "@phosphor-icons/react/dist/csr/Copy";
import { EnvelopeIcon } from "@phosphor-icons/react/dist/csr/Envelope";
import { PlugsIcon } from "@phosphor-icons/react/dist/csr/Plugs";
import { UsersIcon } from "@phosphor-icons/react/dist/csr/Users";
import { WrenchIcon } from "@phosphor-icons/react/dist/csr/Wrench";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";

import { useActionMutation } from "~/entity/hooks/use-action-mutation";
import { Page } from "~/entity/page/page";
import { buildRecordComboboxItem } from "~/entity/picker/combobox-builders";
import { Picker } from "~/entity/picker/picker";
import { AiFundingSettings } from "~/features/account/ai-funding";
import { ChatGptPlanSettings } from "~/features/account/chatgpt-plan-card";
import { PurchaseImportAgentConnection } from "~/features/activity/purchase-import-agent-connection";
import { CalendarConnectDialog } from "~/features/calendar/calendar-connect-dialog";
import { MailImportSettings } from "~/features/email/mail-import-card";
import { MaintenanceRunCard } from "~/features/maintenance/maintenance-run-card";
import { MaintenanceTools } from "~/features/maintenance/maintenance-tools";
import { calendar } from "~/integrations/tanstack-query/generated/catalog/calendar.gen";
import { ledgerParty } from "~/integrations/tanstack-query/generated/catalog/ledgerParty.gen";
import { authClient } from "~/lib/auth-client";
import { copyTextWithToast } from "~/lib/clipboard";
import { hasGmailReadonlyScope } from "~/lib/google-auth";
import { GMAIL_READONLY_SCOPE } from "~/lib/google-auth-constants";
import { pageTitle } from "~/lib/page-title";
import {
  timingResponseSchema,
  type TimingResponse,
} from "~/lib/perf/timing.contract";
import type { ComboboxItem } from "~/ui/combobox/combobox-types";
import { DateDisplay } from "~/ui/common/date-display";
import { IndexedSections } from "~/ui/data-table/indexed-sections";
import { showErrorToast } from "~/ui/feedback/error-details";
import { Row, Section, Stack } from "~/ui/layout";
import { Disclosure } from "~/ui/layout/disclosure";
import { Button } from "~/ui/primitives/button";
import { Description } from "~/ui/primitives/description";
import { StatusText } from "~/ui/primitives/status-text";

export const Route = createFileRoute("/_authenticated/settings")({
  validateSearch: z.object({
    purchaseAgent: purchaseAgentConnectionStatus.optional().catch(undefined),
  }),
  component: SettingsPage,
  head: () => ({ meta: [{ title: pageTitle("Settings") }] }),
});

function SettingsPage() {
  const purchaseAgent = Route.useSearch({
    select: (search) => search.purchaseAgent,
  });
  return (
    <Page variant="list" title="Settings">
      <IndexedSections
        groups={[
          {
            id: "detail-group-connections",
            title: "Connections",
            sections: [
              {
                id: "calendar",
                title: "Calendar",
                icon: CalendarIcon,
                overflowVisible: true,
                description:
                  "Set up editable Calendar access or read-only subscriptions.",
                content: <CalendarConnectDialog />,
              },
              {
                id: "chatgpt",
                title: "ChatGPT plan",
                icon: PlugsIcon,
                overflowVisible: true,
                content: <ChatGptPlanSettings />,
              },
              {
                id: "ai-funding",
                title: "AI funding",
                icon: CoinsIcon,
                overflowVisible: true,
                content: <AiFundingSettings />,
              },
            ],
          },
          {
            id: "detail-group-purchases",
            title: "Mail & purchases",
            sections: [
              {
                id: "purchase-email",
                title: "Purchase email",
                icon: EnvelopeIcon,
                overflowVisible: true,
                content: <GmailAccessSettings />,
              },
              {
                id: "mail-import",
                title: "Mail import",
                icon: EnvelopeIcon,
                overflowVisible: true,
                content: <MailImportSettings />,
              },
              {
                id: "purchase-agent",
                title: "Purchase import agent",
                icon: PlugsIcon,
                overflowVisible: true,
                content: (
                  <PurchaseImportAgentConnection feedback={purchaseAgent} />
                ),
              },
            ],
          },
          {
            id: "detail-group-household",
            title: "Household access",
            sections: [
              {
                id: "member-logins",
                title: "Member logins",
                icon: UsersIcon,
                overflowVisible: true,
                content: <MemberLoginsSettings />,
              },
            ],
          },
          {
            id: "detail-group-maintenance",
            title: "Maintenance",
            sections: [
              {
                id: "maintenance",
                title: "Nightly maintenance",
                description:
                  "The nightly pass drains every backlog as one Run; Run now starts one.",
                icon: ClockIcon,
                content: <MaintenanceRunCard />,
              },
              {
                id: "repair-tools",
                title: "Repair tools",
                description:
                  "Rebuilds derived data on demand. Routine upkeep happens at write time; these are one-off tools.",
                icon: WrenchIcon,
                content: <MaintenanceTools />,
              },
              {
                id: "diagnostics",
                title: "Developer diagnostics",
                icon: WrenchIcon,
                overflowVisible: true,
                content: (
                  <Disclosure summary="Connection diagnostics">
                    <Stack gap="lg">
                      <DiagnosticsCard />
                      <CalendarFeedInspectorCard />
                    </Stack>
                  </Disclosure>
                ),
              },
            ],
          },
        ]}
      />
    </Page>
  );
}

function MemberLoginsSettings() {
  const roster = useQuery(ledgerParty.memberLogins.queryOptions(null));
  const update = useMutation(
    ledgerParty.setMemberLogin.mutationOptions({
      onSuccess: () => toast.success("Member login updated"),
      // No local onError: the global MutationCache toasts unhandled mutation
      // failures with the raw diagnostics (root-provider.tsx), and nothing
      // here renders `update.error` inline.
    }),
  );

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Link each signed-in account to the household member it represents.
      </p>

      {roster.isLoading ? (
        <StatusText>Loading member logins…</StatusText>
      ) : roster.isError ? (
        <StatusText tone="destructive">
          {getErrorMessage(roster.error)}
        </StatusText>
      ) : roster.data?.users.length ? (
        <Stack gap="sm">
          {roster.data.users.map((authUser) => (
            <div
              key={authUser.id}
              className="grid gap-2 border-b border-border pb-3 last:border-0 last:pb-0 md:grid-cols-[minmax(0,1fr)_minmax(12rem,0.8fr)] md:items-center"
            >
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">
                  {authUser.name}
                </div>
                <div className="truncate text-sm text-muted-foreground">
                  {authUser.email}
                </div>
              </div>
              <MemberLoginPicker
                userId={authUser.id}
                userName={authUser.name}
                value={authUser.ledgerParty?.shortcode ?? ""}
                parties={roster.data.parties}
                disabled={update.isPending}
                onChange={(ledgerParty) =>
                  update.mutate({ userId: authUser.id, ledgerParty })
                }
              />
            </div>
          ))}
        </Stack>
      ) : (
        <StatusText>No Better Auth users exist yet.</StatusText>
      )}
    </div>
  );
}

function MemberLoginPicker({
  userId,
  userName,
  value,
  parties,
  disabled,
  onChange,
}: {
  userId: string;
  userName: string;
  value: string;
  parties: readonly {
    shortcode: string;
    name: string;
    userId: string | null;
  }[];
  disabled: boolean;
  onChange: (ledgerParty: string | null) => void;
}) {
  // "" is the unlinked sentinel: not a ledger-party code, so the record
  // picker holds it as-is.
  const items = useMemo(
    (): ComboboxItem[] => [
      { id: "", name: "Not linked" },
      ...parties.map((party) => {
        const item = buildRecordComboboxItem("ledgerParty", {
          id: party.shortcode,
          name: party.name,
        });
        return party.userId !== null && party.userId !== userId
          ? {
              ...item,
              presentation: {
                ...item.presentation,
                disabledReason: "Linked to another login",
              },
            }
          : item;
      }),
    ],
    [parties, userId],
  );
  return (
    <Picker
      mode="choose"
      label={`Ledger party for ${userName}`}
      entity="ledgerParty"
      items={items}
      value={items.find((item) => item.id === value) ?? null}
      disabled={disabled}
      setValue={(next) => onChange(next?.id || null)}
    />
  );
}

function GmailAccessSettings() {
  const accounts = useQuery({
    queryKey: ["auth", "accounts"],
    queryFn: async () => {
      const result = await authClient.listAccounts();
      if (result.error) throw new Error(result.error.message);
      return result.data ?? [];
    },
  });
  const googleAccount = accounts.data?.find(
    (account) => account.providerId === "google",
  );
  const connected = hasGmailReadonlyScope(googleAccount?.scopes);
  const [busy, setBusy] = useState(false);

  const connect = async () => {
    setBusy(true);
    const result = await authClient.linkSocial({
      provider: "google",
      callbackURL: "/settings",
      scopes: [GMAIL_READONLY_SCOPE],
    });
    if (result.error) {
      showErrorToast(
        result.error,
        result.error.message || "Gmail could not be connected.",
      );
      setBusy(false);
    }
  };
  const disconnect = async () => {
    if (!googleAccount) return;
    setBusy(true);
    const result = await authClient.unlinkAccount({
      accountId: googleAccount.id,
    });
    if (result.error) {
      showErrorToast(
        result.error,
        result.error.message || "Gmail could not be disconnected.",
      );
    } else {
      toast.success("Google and Gmail disconnected");
      await accounts.refetch();
    }
    setBusy(false);
  };

  return (
    <div className="space-y-3">
      <Row align="start" justify="between" gap="md" className="max-md:flex-col">
        <Stack gap="tight">
          <p className="text-xs text-muted-foreground">
            {connected
              ? "Google sign-in and read-only Gmail access are connected for order discovery and receipt attachments."
              : googleAccount
                ? "Google is linked, but read-only Gmail access is missing. Reconnect to restore order matching."
                : "Connect Google and read-only Gmail so Cubby can sign you in and match order mail to statement charges."}
          </p>
        </Stack>
        <Button
          type="button"
          variant={connected ? "outline" : "default"}
          disabled={busy || accounts.isLoading}
          onClick={() => void (connected ? disconnect() : connect())}
        >
          <EnvelopeIcon className="size-4" />
          {busy
            ? "Working…"
            : connected
              ? "Disconnect Google & Gmail"
              : googleAccount
                ? "Reconnect Google & Gmail"
                : "Connect Google & Gmail"}
        </Button>
      </Row>
    </div>
  );
}

function CalendarFeedInspectorCard() {
  const { data, error, isFetching, refetch } = useQuery({
    ...calendar.inspectFeed.queryOptions(),
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const json = data ? JSON.stringify(data, null, 2) : null;
  const clearWrite = useActionMutation({
    mutationFn: calendar.clearUncertainWrite.mutationOptions,
    success: "Uncertain write cleared",
    error: "The uncertain write could not be cleared. Try again.",
  });

  return (
    <Section
      title="Calendar state"
      headingAs="h4"
      compact
      caption="Durable Object metadata only. Credentials and calendar contents are omitted; jurisdiction is not the active colo."
      actions={
        <>
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={() => void refetch()}
            disabled={isFetching}
          >
            <ArrowClockwiseIcon
              className={`size-3 ${isFetching ? "animate-spin" : ""}`}
            />
            {isFetching ? "Reading…" : "Refresh"}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="xs"
            disabled={!json}
            onClick={() => {
              if (!json) return;
              void copyTextWithToast(json, "Calendar feed state copied");
            }}
          >
            <CopyIcon className="size-3" />
            Copy JSON
          </Button>
        </>
      }
    >
      {error ? (
        <StatusText as="p" tone="destructive" className="text-xs">
          Calendar state could not be loaded. Try again shortly.
        </StatusText>
      ) : json ? (
        <Stack gap="md">
          {data?.caldav?.uncertainWrites.map((write) => (
            <Stack key={`${write.collection}/${write.filename}`} gap="xs">
              <Description as="p" size="xs">
                Uncertain write: {write.collection}/{write.filename}
                {write.shortcode ? ` (${write.shortcode})` : ""}. Check this
                record in Cubby before clearing. Clearing only unblocks calendar
                edits; it never repeats or deletes a change.
              </Description>
              <Button
                variant="outline"
                size="xs"
                disabled={clearWrite.isPending}
                onClick={() =>
                  clearWrite.mutate({
                    collection: write.collection,
                    filename: write.filename,
                  })
                }
              >
                Clear uncertain write
              </Button>
            </Stack>
          ))}
          <pre className="max-h-[32rem] overflow-auto bg-muted/35 p-4 font-mono text-xs">
            {json}
          </pre>
        </Stack>
      ) : (
        <Description as="p" size="xs">
          {isFetching ? "Reading calendar state…" : "No state returned."}
        </Description>
      )}
    </Section>
  );
}

function DiagnosticsCard() {
  const { data, error, isFetching, refetch, dataUpdatedAt } =
    useQuery<TimingResponse>({
      // The one query in the app that is not an operation: a raw fetch of
      // `/api/debug/timing`, so it owns its key rather than deriving one.
      queryKey: ["debug", "timing"] as const,
      queryFn: async () => {
        const res = await fetch("/api/debug/timing");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return timingResponseSchema.parse(await res.json());
      },
      refetchOnWindowFocus: false,
    });

  return (
    <Section
      title="Diagnostics"
      headingAs="h4"
      compact
      caption="Latency of core infrastructure — database, USDA API, and UPC lookup."
      actions={
        <Button
          variant="outline"
          size="xs"
          onClick={() => refetch()}
          disabled={isFetching}
        >
          {isFetching ? "Measuring…" : "Re-run"}
        </Button>
      }
    >
      <div className="divide-y divide-border/60">
        {error ? (
          <StatusText as="p" tone="destructive" className="py-4 text-xs">
            Timing check failed: {getErrorMessage(error)}
          </StatusText>
        ) : !data ? (
          <Description as="p" size="xs" className="py-4">
            Measuring…
          </Description>
        ) : (
          <>
            {data.results.map((result) => (
              <Row
                key={result.label}
                align="start"
                justify="between"
                gap="md"
                className="py-2"
              >
                <Stack gap="tight" className="min-w-0">
                  <code className="block truncate font-mono text-xs text-muted-foreground">
                    {result.label}
                  </code>
                  {result.error && (
                    <p className="text-xs text-destructive">{result.error}</p>
                  )}
                </Stack>
                <span className="shrink-0 font-mono text-sm font-medium tabular-nums">
                  {result.durationMs} ms
                </span>
              </Row>
            ))}
            <Row
              align="center"
              justify="between"
              gap="md"
              className="py-2 text-xs text-muted-foreground"
            >
              <span>
                Last run <DateDisplay timestamp={dataUpdatedAt} />
              </span>
              <span className="font-mono tabular-nums">
                total {data.totalMs} ms
              </span>
            </Row>
          </>
        )}
      </div>
    </Section>
  );
}
