import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { z } from "zod";
import { IconPattern } from "~/components/common/icon-pattern";
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

// Only the two params this screen renders from. The rest of the signed
// authorize query stays in the address bar untouched — the oauthProviderClient
// fetch hook reads it from `window.location.search` when consent is submitted.
// See auth.$authView for why widening this is the wrong move.
const searchSchema = z.object({
  client_id: z.string().optional().catch(undefined),
  scope: z.string().optional().catch(undefined),
});

export const Route = createFileRoute("/oauth/consent")({
  validateSearch: searchSchema,
  component: ConsentPage,
});

/** What each advertised scope actually grants, in plain language. */
const SCOPE_DESCRIPTIONS: Record<string, string> = {
  openid: "Confirm who you are",
  profile: "Read your name and avatar",
  email: "Read your email address",
  offline_access: "Stay signed in without re-authorizing",
};

interface PublicClient {
  client_id: string;
  client_name?: string;
  client_uri?: string;
  logo_uri?: string;
  policy_uri?: string;
  tos_uri?: string;
}

function ConsentPage() {
  const { client_id: clientId, scope } = Route.useSearch();
  const hydrated = useHydrated();
  const [client, setClient] = useState<PublicClient | null>(null);
  const [submitting, setSubmitting] = useState<"accept" | "deny" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const scopes = scope?.split(" ").filter(Boolean) ?? [];

  useEffect(() => {
    if (!clientId) return;
    let cancelled = false;
    // $fetch rather than a generated method: this endpoint is only ever called
    // from this one screen, and the explicit path avoids depending on how the
    // client proxy camelCases `/oauth2/public-client`.
    void authClient
      .$fetch<PublicClient>("/oauth2/public-client", {
        query: { client_id: clientId },
      })
      .then((res) => {
        if (!cancelled && res.data) setClient(res.data);
      });
    return () => {
      cancelled = true;
    };
  }, [clientId]);

  async function decide(accept: boolean) {
    setSubmitting(accept ? "accept" : "deny");
    setError(null);
    try {
      const res = await authClient.oauth2.consent({ accept });
      if (res.error) throw new Error(res.error.message ?? "Consent failed");
      const url = res.data?.url;
      if (!url) throw new Error("No redirect returned");
      // A full navigation, not router.navigate — the destination is the OAuth
      // client's callback, which is off-origin.
      window.location.href = url;
    } catch (err) {
      setError(getErrorMessage(err));
      setSubmitting(null);
    }
  }

  const appName = client?.client_name ?? "An application";

  return (
    <div className="auth-background relative flex min-h-screen items-center justify-center overflow-hidden p-4">
      <IconPattern />
      <div className="relative z-10 w-full max-w-md">
        <Card>
          <CardHeader>
            <div className="font-mono text-2xs text-slate uppercase tracking-wider">
              Authorize access
            </div>
            <CardTitle>{appName}</CardTitle>
            <CardDescription>
              {client?.client_uri
                ? `${client.client_uri} wants to access your Cubby account.`
                : "This application wants to access your Cubby account."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Stack gap="md">
              {clientId && (
                <div className="font-mono text-2xs text-slate">{clientId}</div>
              )}
              {scopes.length > 0 && (
                <Stack gap="sm">
                  <div className="font-mono text-2xs text-slate uppercase tracking-wider">
                    Permissions requested
                  </div>
                  <Stack gap="xs" as="ul">
                    {scopes.map((s) => (
                      <Row key={s} align="center" gap="sm" as="li">
                        <Badge variant="secondary">{s}</Badge>
                        <span className="text-muted-foreground text-xs">
                          {SCOPE_DESCRIPTIONS[s] ?? "Additional access"}
                        </span>
                      </Row>
                    ))}
                  </Stack>
                </Stack>
              )}

              <p className="text-muted-foreground text-xs">
                Approving also lets this application read and modify your
                inventory, recipes, and other Cubby data through the MCP API.
              </p>

              {error && <p className="text-destructive text-xs">{error}</p>}

              <Row gap="sm" justify="end">
                <Button
                  variant="outline"
                  onClick={() => decide(false)}
                  disabled={!hydrated || submitting !== null}
                >
                  {submitting === "deny" ? "Denying…" : "Deny"}
                </Button>
                <Button
                  onClick={() => decide(true)}
                  disabled={!hydrated || submitting !== null}
                >
                  {submitting === "accept" ? "Authorizing…" : "Allow"}
                </Button>
              </Row>
            </Stack>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
