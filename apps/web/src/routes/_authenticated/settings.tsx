import { ArrowClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowClockwise";
import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { CopyIcon } from "@phosphor-icons/react/dist/csr/Copy";
import { EnvelopeIcon } from "@phosphor-icons/react/dist/csr/Envelope";
import { WrenchIcon } from "@phosphor-icons/react/dist/csr/Wrench";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";

import { useActionMutation } from "~/app/_components/hooks/useActionMutation";
import { CalendarConnectDialog } from "~/app/calendar/calendar-connect-dialog";
import { calendar } from "~/app/calendar/calendar.functions";
import { AwaitingWorkCard } from "~/app/problems/components/awaiting-work-card";
import { MaintenanceCard } from "~/app/problems/components/maintenance-card";
import { Row, Stack } from "~/components/layout";
import { Page } from "~/components/page/Page";
import { Button } from "~/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "~/components/ui/collapsible";
import { Description } from "~/components/ui/description";
import { Eyebrow } from "~/components/ui/eyebrow";
import { Input } from "~/components/ui/input";
import { NativeSelect } from "~/components/ui/native-select";
import { StatusText } from "~/components/ui/status-text";
import { authClient } from "~/lib/auth-client";
import { copyText } from "~/lib/clipboard";
import { getErrorMessage } from "~/lib/error-utils";
import { hasGmailReadonlyScope } from "~/lib/google-auth";
import { GMAIL_READONLY_SCOPE } from "~/lib/google-auth-constants";
import { readJsonOrThrow } from "~/lib/http-error";
import { pageTitle } from "~/lib/page-title";
import {
  timingResponseSchema,
  type TimingResponse,
} from "~/routes/api/debug/timing";
import { merchantRulesResponse } from "~/routes/api/import/merchant-rules";
import { memberLoginsResponse } from "~/routes/api/settings/member-logins";

export const Route = createFileRoute("/_authenticated/settings")({
  component: SettingsPage,
  head: () => ({ meta: [{ title: pageTitle("Settings") }] }),
});

function SettingsPage() {
  const [devOpen, setDevOpen] = useState(false);
  return (
    <Page variant="list" title="Settings">
      <Stack gap="md" className="max-w-2xl pb-6 md:gap-6">
        {/* User-facing settings — the everyday prefs, kept above the fold. */}
        <CalendarAccessCard />
        <GmailAccessCard />
        <Card className="max-md:border-x-0">
          <CardHeader>
            <CardTitle>Activity connections</CardTitle>
            <CardDescription>
              Manage the accounts and devices that can perform household work.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <a
              className="text-primary hover:underline"
              href="/activity?view=connections"
            >
              Open connections
            </a>
          </CardContent>
        </Card>
        <MemberLoginsCard />
        <MerchantVendorRulesCard />

        {/* Everything dev/debug/maintenance lives behind one collapsed
            disclosure so the user-facing prefs above aren't drowned in flags. */}
        <Collapsible open={devOpen} onOpenChange={setDevOpen}>
          <CollapsibleTrigger
            render={
              <button
                type="button"
                aria-label="Toggle developer tools"
                className="flex min-h-11 w-full items-center justify-between border border-[var(--border)] bg-muted/40 px-2 py-2 text-left transition-colors hover:bg-muted md:px-4"
              />
            }
          >
            <Row align="center" gap="sm">
              <WrenchIcon className="size-4 text-muted-foreground" />
              <Stack gap="tight">
                <Eyebrow as="span">Developer / Maintenance</Eyebrow>
                <Description size="xs">
                  Diagnostics and force-run batch fixes.
                </Description>
              </Stack>
            </Row>
            <CaretDownIcon
              className={`size-4 shrink-0 text-muted-foreground transition-transform ${
                devOpen ? "rotate-180" : ""
              }`}
            />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <Stack gap="lg" className="pt-4">
              <DiagnosticsCard />

              <CalendarFeedInspectorCard enabled={devOpen} />

              <AwaitingWorkCard />

              <MaintenanceCard />
            </Stack>
          </CollapsibleContent>
        </Collapsible>
      </Stack>
    </Page>
  );
}

function MerchantVendorRulesCard() {
  const queryClient = useQueryClient();
  const [merchant, setMerchant] = useState("");
  const [vendorId, setVendorId] = useState("");
  const rules = useQuery({
    queryKey: ["purchase-import", "merchant-rules"],
    queryFn: async () => {
      const response = await fetch("/api/import/merchant-rules");
      return readJsonOrThrow(
        response,
        merchantRulesResponse,
        "Merchant routing rules could not load.",
      );
    },
  });
  const save = useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/import/merchant-rules", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ merchant, vendorId }),
      });
      return readJsonOrThrow(
        response,
        merchantRulesResponse,
        "Merchant routing rule could not save.",
        { method: "POST" },
      );
    },
    onSuccess: (data) => {
      queryClient.setQueryData(["purchase-import", "merchant-rules"], data);
      setMerchant("");
      toast.success("Merchant routing saved");
    },
  });
  return (
    <Card className="max-md:border-x-0">
      <CardHeader>
        <CardTitle>Purchase merchant routing</CardTitle>
        <CardDescription>
          Route a statement merchant label to the vendor whose orders should be
          searched.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {rules.isError ? (
          <StatusText tone="destructive">
            {getErrorMessage(rules.error)}
          </StatusText>
        ) : (
          <Stack gap="md">
            <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] md:items-end">
              <label
                className="grid gap-1 text-sm font-medium"
                htmlFor="purchase-merchant-label"
              >
                Merchant label
                <Input
                  id="purchase-merchant-label"
                  value={merchant}
                  onChange={(event) => setMerchant(event.target.value)}
                  placeholder="AMZN Mktp"
                />
              </label>
              <label
                className="grid gap-1 text-sm font-medium"
                htmlFor="purchase-merchant-vendor"
              >
                Vendor
                <NativeSelect
                  id="purchase-merchant-vendor"
                  value={vendorId}
                  onChange={(event) => setVendorId(event.target.value)}
                >
                  <option value="">Choose a vendor</option>
                  {rules.data?.vendors.map((vendor) => (
                    <option key={vendor.shortcode} value={vendor.shortcode}>
                      {vendor.name}
                    </option>
                  ))}
                </NativeSelect>
              </label>
              <Button
                type="button"
                disabled={!merchant.trim() || !vendorId || save.isPending}
                onClick={() => save.mutate()}
              >
                Save rule
              </Button>
            </div>
            {rules.data?.rules.length ? (
              <Stack gap="tight">
                {rules.data.rules.map((rule) => (
                  <div
                    key={rule.merchant}
                    className="flex justify-between gap-4 border-b border-border py-2 text-sm last:border-0"
                  >
                    <span>{rule.merchant}</span>
                    <span className="text-muted-foreground">
                      {rule.vendorName}
                    </span>
                  </div>
                ))}
              </Stack>
            ) : (
              <StatusText>No merchant routing rules yet.</StatusText>
            )}
          </Stack>
        )}
      </CardContent>
    </Card>
  );
}

function MemberLoginsCard() {
  const queryClient = useQueryClient();
  const roster = useQuery({
    queryKey: ["settings", "member-logins"],
    queryFn: async () => {
      const response = await fetch("/api/settings/member-logins");
      return readJsonOrThrow(
        response,
        memberLoginsResponse,
        "Member logins could not load.",
      );
    },
  });
  const update = useMutation({
    mutationFn: async (input: {
      userId: string;
      ledgerParty: string | null;
    }) => {
      const response = await fetch("/api/settings/member-logins", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      return readJsonOrThrow(
        response,
        memberLoginsResponse,
        "Member login could not be updated.",
        { method: "PATCH" },
      );
    },
    onSuccess: (data) => {
      queryClient.setQueryData(["settings", "member-logins"], data);
      void queryClient.refetchQueries({
        queryKey: ["purchase-import", "runs"],
      });
      toast.success("Member login updated");
    },
    // No local onError: the global MutationCache toasts unhandled mutation
    // failures with the raw diagnostics (root-provider.tsx), and nothing here
    // renders `update.error` inline.
  });

  return (
    <Card className="max-md:border-x-0">
      <CardHeader>
        <CardTitle>Member logins</CardTitle>
        <CardDescription>
          Link each signed-in account to the household member it represents.
        </CardDescription>
      </CardHeader>
      <CardContent>
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
                <NativeSelect
                  aria-label={`Ledger party for ${authUser.name}`}
                  value={authUser.ledgerParty?.shortcode ?? ""}
                  disabled={update.isPending}
                  onChange={(event) =>
                    update.mutate({
                      userId: authUser.id,
                      ledgerParty: event.target.value || null,
                    })
                  }
                >
                  <option value="">Not linked</option>
                  {roster.data.parties.map((party) => (
                    <option
                      key={party.shortcode}
                      value={party.shortcode}
                      disabled={
                        party.userId !== null && party.userId !== authUser.id
                      }
                    >
                      {party.name}
                      {party.userId !== null && party.userId !== authUser.id
                        ? " — linked"
                        : ""}
                    </option>
                  ))}
                </NativeSelect>
              </div>
            ))}
          </Stack>
        ) : (
          <StatusText>No Better Auth users exist yet.</StatusText>
        )}
      </CardContent>
    </Card>
  );
}

function GmailAccessCard() {
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
      toast.error(result.error.message || "Gmail could not be connected.");
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
      toast.error(result.error.message || "Gmail could not be disconnected.");
    } else {
      toast.success("Google and Gmail disconnected");
      await accounts.refetch();
    }
    setBusy(false);
  };

  return (
    <Card className="max-md:border-x-0">
      <CardHeader>
        <Row
          align="start"
          justify="between"
          gap="md"
          className="max-md:flex-col"
        >
          <Stack gap="tight">
            <CardTitle>Purchase email</CardTitle>
            <CardDescription>
              {connected
                ? "Google sign-in and read-only Gmail access are connected for order discovery and receipt attachments."
                : googleAccount
                  ? "Google is linked, but read-only Gmail access is missing. Reconnect to restore order matching."
                  : "Connect Google and read-only Gmail so Cubby can sign you in and match order mail to statement charges."}
            </CardDescription>
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
      </CardHeader>
    </Card>
  );
}

function CalendarAccessCard() {
  return (
    <Card className="max-md:border-x-0">
      <CardHeader>
        <Row
          align="start"
          justify="between"
          gap="md"
          className="max-md:flex-col"
        >
          <Stack gap="tight">
            <CardTitle>Calendar</CardTitle>
            <CardDescription>
              Set up editable Calendar access or read-only subscriptions.
            </CardDescription>
          </Stack>
          <div className="shrink-0">
            <CalendarConnectDialog />
          </div>
        </Row>
      </CardHeader>
    </Card>
  );
}

function CalendarFeedInspectorCard({ enabled }: { enabled: boolean }) {
  const { data, error, isFetching, refetch } = useQuery({
    ...calendar.inspectFeed.queryOptions(),
    enabled,
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
    <Card>
      <CardHeader>
        <Row
          align="start"
          justify="between"
          gap="md"
          className="max-md:flex-col"
        >
          <Stack gap="sm">
            <CardTitle>Calendar state</CardTitle>
            <CardDescription>
              Durable Object metadata only. Credentials and calendar contents
              are omitted; jurisdiction is not the active colo.
            </CardDescription>
          </Stack>
          <Row gap="xs" justify="end" className="shrink-0 max-md:w-full">
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
                void copyText(json).then((copied) =>
                  copied
                    ? toast.success("Calendar feed state copied")
                    : toast.error("Copy failed"),
                );
              }}
            >
              <CopyIcon className="size-3" />
              Copy JSON
            </Button>
          </Row>
        </Row>
      </CardHeader>
      <CardContent>
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
                  record in Cubby before clearing. Clearing only unblocks
                  calendar edits; it never repeats or deletes a change.
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
      </CardContent>
    </Card>
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
    <Card>
      <CardHeader>
        <Row align="start" justify="between" gap="md">
          <Stack gap="sm">
            <CardTitle>Diagnostics</CardTitle>
            <CardDescription>
              Latency of core infrastructure — database, USDA API, and UPC
              lookup.
            </CardDescription>
          </Stack>
          <Button
            variant="outline"
            size="xs"
            onClick={() => refetch()}
            disabled={isFetching}
          >
            {isFetching ? "Measuring…" : "Re-run"}
          </Button>
        </Row>
      </CardHeader>
      <CardContent className="divide-y divide-border/60">
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
                Last run {new Date(dataUpdatedAt).toLocaleTimeString()}
              </span>
              <span className="font-mono tabular-nums">
                total {data.totalMs} ms
              </span>
            </Row>
          </>
        )}
      </CardContent>
    </Card>
  );
}
