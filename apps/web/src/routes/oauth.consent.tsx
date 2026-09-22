import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";

import { AuthEntryFrame } from "~/app/auth/auth-entry-frame";
import {
  canAllowConsent,
  type PublicClientLookupState,
  verifyPublicClient,
} from "~/app/auth/oauth-consent-client";
import { Row, Stack } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { useHydrated } from "~/hooks/useHydrated";
import { authClient } from "~/lib/auth-client";
import { getErrorMessage } from "~/lib/error-utils";
import { pageTitle } from "~/lib/page-title";
import { urlStringParam } from "~/lib/search-params";

// Only the two params this screen renders from. The rest of the signed
// authorize query stays in the address bar untouched — the oauthProviderClient
// fetch hook reads it from `window.location.search` when consent is submitted.
// See auth.$authView for why widening this is the wrong move.
const searchSchema = z.object({
  client_id: urlStringParam,
  scope: urlStringParam,
});

export const Route = createFileRoute("/oauth/consent")({
  validateSearch: searchSchema,
  head: () => ({ meta: [{ title: pageTitle("Authorize app") }] }),
  component: ConsentPage,
});

/** What each advertised scope actually grants, in plain language. */
const SCOPE_DESCRIPTIONS = {
  openid: "Confirm who you are",
  profile: "Read your name and avatar",
  email: "Read your email address",
  offline_access: "Stay signed in without re-authorizing",
} satisfies Record<"openid" | "profile" | "email" | "offline_access", string>;

const scopeDescription = (scopeName: string): string =>
  Object.entries(SCOPE_DESCRIPTIONS).find(
    ([name]) => name === scopeName,
  )?.[1] ?? "Additional access";

function ConsentPage() {
  const { client_id: clientId, scope } = Route.useSearch();
  const hydrated = useHydrated();
  const [clientSnapshot, setClientSnapshot] = useState<{
    clientId: string | undefined;
    state: PublicClientLookupState;
  }>({
    clientId,
    state: { kind: "loading" },
  });
  const clientLookupVersion = useRef(0);
  const [submitting, setSubmitting] = useState<"accept" | "deny" | null>(null);
  const [decisionError, setDecisionError] = useState<string | null>(null);

  const scopes = scope?.split(" ").filter(Boolean) ?? [];

  const loadClient = useCallback(async () => {
    const requestVersion = ++clientLookupVersion.current;
    setClientSnapshot({ clientId, state: { kind: "loading" } });
    const nextState = await verifyPublicClient(clientId, (requestedClientId) =>
      // $fetch rather than a generated method: this endpoint is only ever
      // called from this one screen, and the explicit path avoids depending on
      // how the client proxy camelCases `/oauth2/public-client`.
      authClient.$fetch("/oauth2/public-client", {
        query: { client_id: requestedClientId },
      }),
    );
    if (requestVersion === clientLookupVersion.current) {
      setClientSnapshot({ clientId, state: nextState });
    }
  }, [clientId]);

  useEffect(() => {
    void loadClient();
  }, [loadClient]);

  useEffect(() => {
    return () => {
      clientLookupVersion.current += 1;
    };
  }, []);

  async function decide(accept: boolean) {
    setSubmitting(accept ? "accept" : "deny");
    setDecisionError(null);
    try {
      const res = await authClient.oauth2.consent({ accept });
      if (res.error) throw new Error(res.error.message ?? "Consent failed");
      const url = res.data?.url;
      if (!url) throw new Error("No redirect returned");
      // A full navigation, not router.navigate — the destination is the OAuth
      // client's callback, which is off-origin.
      window.location.href = url;
    } catch (err) {
      setDecisionError(getErrorMessage(err));
      setSubmitting(null);
    }
  }

  const clientState: PublicClientLookupState =
    clientSnapshot.clientId === clientId
      ? clientSnapshot.state
      : { kind: "loading" };
  const client = clientState.kind === "verified" ? clientState.client : null;
  const appName = client?.client_name ?? "Requested application";
  const allowEnabled = canAllowConsent(
    hydrated,
    clientId,
    clientState,
    submitting !== null,
  );

  return (
    <AuthEntryFrame>
      <Card>
        <CardHeader>
          <div className="text-xs text-slate">Authorize access</div>
          <CardTitle>{appName}</CardTitle>
          <CardDescription>
            {clientState.kind === "loading"
              ? "Verifying the requesting application…"
              : client?.client_uri
                ? `${client.client_uri} wants to access your Cubby account.`
                : "This application wants to access your Cubby account."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Stack gap="md">
            {clientState.kind === "verified" && clientId && (
              <div className="font-mono text-2xs text-slate">{clientId}</div>
            )}
            {clientState.kind === "invalid" && (
              <p role="alert" className="text-xs text-destructive">
                {clientState.message}
              </p>
            )}
            {clientState.kind === "error" && (
              <Stack gap="sm">
                <p role="alert" className="text-xs text-destructive">
                  {clientState.message}
                </p>
                <p className="text-2xs text-muted-foreground">
                  {clientState.detail}
                </p>
                <div>
                  <Button variant="outline" onClick={() => void loadClient()}>
                    Retry verification
                  </Button>
                </div>
              </Stack>
            )}
            {scopes.length > 0 && (
              <Stack gap="sm">
                <div className="text-xs text-slate">Permissions requested</div>
                <Stack gap="xs" as="ul">
                  {scopes.map((s) => (
                    <Row key={s} align="center" gap="sm" as="li">
                      <Badge variant="secondary">{s}</Badge>
                      <span className="text-xs text-muted-foreground">
                        {scopeDescription(s)}
                      </span>
                    </Row>
                  ))}
                </Stack>
              </Stack>
            )}

            <p className="text-xs text-muted-foreground">
              Approving also lets this application read and modify your
              inventory, recipes, and other Cubby data through the MCP API.
            </p>

            {decisionError && (
              <p role="alert" className="text-xs text-destructive">
                {decisionError}
              </p>
            )}

            <Row gap="sm" justify="end">
              <Button
                variant="outline"
                onClick={() => decide(false)}
                disabled={!hydrated || submitting !== null}
              >
                {submitting === "deny" ? "Denying…" : "Deny"}
              </Button>
              <Button onClick={() => decide(true)} disabled={!allowEnabled}>
                {submitting === "accept" ? "Authorizing…" : "Allow"}
              </Button>
            </Row>
          </Stack>
        </CardContent>
      </Card>
    </AuthEntryFrame>
  );
}
